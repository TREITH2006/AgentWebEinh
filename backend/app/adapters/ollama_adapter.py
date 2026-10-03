"""Ollama adapter — the local model's reasoning and embedding endpoint.

Two invariants:

* **Health never triggers inference.** :meth:`OllamaAdapter.health` reads
  ``GET /api/tags`` only. Calling a chat model from a liveness probe would load
  multi-gigabyte weights into VRAM as a side effect of opening the frontend.
* **Never downloads.** A missing model is reported as a problem to fix, not
  quietly pulled, so a running service cannot mutate the user's disk.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

from ..config import Settings
from .base import AdapterError, IntegrationHealth, redact

logger = logging.getLogger("agentwebeinh.ollama")


class OllamaAdapter:
    """Thin async client for the Ollama HTTP API."""

    name = "ollama"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=settings.ollama_url,
            timeout=httpx.Timeout(settings.ollama_timeout_seconds, connect=5.0),
        )

    # ----------------------------------------------------------------- health --

    async def health(self) -> IntegrationHealth:
        if not self._settings.ollama_enabled:
            return IntegrationHealth(
                self.name, "disabled", "Ollama integration is disabled (AWE_OLLAMA_ENABLED=false)."
            )
        try:
            response = await self._client.get("/api/tags", timeout=self._settings.ollama_health_timeout_seconds)
        except httpx.HTTPError as exc:
            return IntegrationHealth(
                self.name,
                "down",
                f"Cannot reach Ollama at {self._settings.ollama_url}: {redact(str(exc), limit=160)}",
            )

        if response.status_code >= 400:
            return IntegrationHealth(
                self.name, "down", f"Ollama returned HTTP {response.status_code}."
            )

        try:
            payload = response.json()
        except ValueError:
            return IntegrationHealth(self.name, "down", "Ollama returned a non-JSON response.")

        models = {
            str(item.get("name", ""))
            for item in (payload.get("models") or [])
            if isinstance(item, dict)
        }
        chat_ready = self._settings.ollama_model in models
        embed_ready = self._settings.ollama_embedding_model in models

        info: dict[str, Any] = {
            "base_url": self._settings.ollama_url,
            "chat_model": self._settings.ollama_model,
            "chat_model_present": chat_ready,
            "embedding_model": self._settings.ollama_embedding_model,
            "embedding_model_present": embed_ready,
            "model_count": len(models),
        }

        if chat_ready and embed_ready:
            state, detail = "up", f"Ollama ready with {len(models)} model(s)."
        elif chat_ready:
            state, detail = "degraded", (
                f"Ollama is up but the embedding model "
                f"{self._settings.ollama_embedding_model!r} is not pulled."
            )
        else:
            state, detail = "degraded", (
                f"Ollama is up but the chat model {self._settings.ollama_model!r} is not pulled. "
                "Pull it with `ollama pull`; this service never downloads models."
            )
        return IntegrationHealth(self.name, state, detail, info)

    # ------------------------------------------------------------ completion --

    async def chat(
        self,
        system: str,
        user: str,
        *,
        images: list[str] | None = None,
        temperature: float | None = None,
        num_predict: int | None = None,
        as_json: bool = True,
    ) -> str:
        """Single-turn completion. Returns the model's text, never raises on shape.

        Model output is untrusted: it is parsed as JSON when possible and
        otherwise surfaced as prose for the orchestrator to explain.
        """
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        if images:
            # Vision models take base64 images; kept opt-in so text-only runs stay cheap.
            messages[1]["images"] = images

        body: dict[str, Any] = {
            "model": self._settings.ollama_model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": self._settings.ollama_temperature if temperature is None else temperature,
                "num_ctx": self._settings.ollama_num_ctx,
                **({"num_predict": num_predict} if num_predict else {}),
            },
            "keep_alive": self._settings.ollama_keep_alive,
        }
        if as_json:
            body["format"] = "json"

        try:
            response = await self._client.post("/api/chat", json=body)
        except httpx.HTTPError as exc:
            raise AdapterError(
                f"Ollama request failed: {redact(str(exc), limit=200)}",
                code="ollama_unreachable",
                retryable=True,
            ) from exc

        if response.status_code >= 400:
            raise AdapterError(
                f"Ollama returned HTTP {response.status_code}: "
                f"{redact(response.text, limit=300)}",
                code="ollama_http_error",
                retryable=response.status_code >= 500,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise AdapterError("Ollama returned a non-JSON response.", code="ollama_bad_json") from exc

        message = payload.get("message") or {}
        content = message.get("content")
        if not isinstance(content, str) or not content.strip():
            raise AdapterError("Ollama returned an empty completion.", code="ollama_empty")
        return content

    async def chat_json(self, system: str, user: str, **kwargs: Any) -> dict[str, Any]:
        """Completion parsed as a JSON object.

        Local models do not honour ``format: json`` perfectly, so a fenced block
        or a bare array is recovered rather than failing the run.
        """
        raw = await self.chat(system, user, as_json=True, **kwargs)
        parsed = _coerce_json_object(raw)
        if parsed is None:
            raise AdapterError(
                f"Model output was not a JSON object: {redact(raw, limit=200)}",
                code="ollama_bad_schema",
            )
        return parsed

    # ------------------------------------------------------------ embeddings --

    async def embed(self, texts: list[str]) -> list[list[float]]:
        """Batch embeddings, used for report synthesis grouping."""
        if not texts:
            return []
        try:
            response = await self._client.post(
                "/api/embed",
                json={"model": self._settings.ollama_embedding_model, "input": texts},
            )
        except httpx.HTTPError as exc:
            raise AdapterError(
                f"Ollama embedding request failed: {redact(str(exc), limit=200)}",
                code="ollama_embed_unreachable",
                retryable=True,
            ) from exc

        if response.status_code >= 400:
            raise AdapterError(
                f"Ollama embedding endpoint returned HTTP {response.status_code}.",
                code="ollama_embed_http_error",
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise AdapterError("Ollama returned non-JSON embeddings.", code="ollama_embed_bad_json") from exc

        vectors = payload.get("embeddings")
        if not isinstance(vectors, list):
            raise AdapterError("Ollama embedding response had no 'embeddings'.", code="ollama_embed_bad_schema")
        return [list(map(float, vector)) for vector in vectors if isinstance(vector, list)]

    async def close(self) -> None:
        await self._client.aclose()


def _coerce_json_object(raw: str) -> dict[str, Any] | None:
    """Best-effort extraction of a JSON object from model output."""
    text = raw.strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        pass
    else:
        return parsed if isinstance(parsed, dict) else None

    # Strip a ```json fence if the model wrapped its answer.
    if text.startswith("```"):
        lines = text.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        try:
            parsed = json.loads("\n".join(lines).strip())
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None

    # Fall back to the outermost {...} span.
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


__all__ = ["OllamaAdapter"]
