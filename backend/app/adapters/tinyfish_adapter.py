"""TinyFish adapter — optional web research.

Entirely opt-in (``AWE_TINYFISH_ENABLED=false`` by default). The core product must
not depend on a paid or remote service, and every call here costs wallet credits,
so it is only ever used when a task's research step cannot be satisfied locally.

The exact subcommand shapes were read from ``tinyfish --help`` rather than
assumed: ``search query <q>``, ``fetch content get <urls...>``, ``doctor``. All of
them emit JSON by default (``--pretty`` switches to prose).

Search results are attacker-controllable text. URLs are therefore validated to
``http(s)`` before being handed back to a fetch call, and nothing returned here is
ever treated as an instruction.
"""

from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlparse

from ..config import Settings
from .base import AdapterError, AdapterUnavailable, IntegrationHealth, redact, run_command

logger = logging.getLogger("agentwebeinh.tinyfish")

#: Cap on how much extracted page text is handed to the model.
MAX_FETCH_CHARS = 12_000


class TinyFishAdapter:
    """Search and page-extraction helper backed by the TinyFish CLI."""

    name = "tinyfish"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    # ----------------------------------------------------------------- health --

    async def health(self) -> IntegrationHealth:
        if not self._settings.tinyfish_enabled:
            return IntegrationHealth(
                self.name, "disabled", "TinyFish integration is disabled (AWE_TINYFISH_ENABLED=false)."
            )
        try:
            code, stdout, stderr = await run_command(
                [self._settings.tinyfish_cli, "doctor"],
                timeout=self._settings.tinyfish_timeout_seconds,
            )
        except AdapterUnavailable as exc:
            return IntegrationHealth(self.name, "down", str(exc))
        except AdapterError as exc:
            return IntegrationHealth(self.name, "down", str(exc))

        if code != 0:
            return IntegrationHealth(
                self.name,
                "down",
                f"`tinyfish doctor` exited {code}: {redact(stderr or stdout, limit=200)}",
            )
        return IntegrationHealth(self.name, "up", "TinyFish CLI is installed and reachable.")

    # ----------------------------------------------------------------- search --

    async def search(
        self,
        query: str,
        *,
        limit: int | None = None,
        language: str | None = None,
    ) -> list[dict[str, Any]]:
        """Run a search and return a bounded list of ``{url,title,snippet}``."""
        self._require_enabled()
        capped = min(limit or self._settings.tinyfish_max_results, self._settings.tinyfish_max_results)

        argv = [self._settings.tinyfish_cli, "search", "query", query]
        if language:
            argv += ["--language", language]

        payload = await self._invoke(argv)
        results = _results_of(payload)
        cleaned: list[dict[str, Any]] = []
        for item in results:
            if not isinstance(item, dict):
                continue
            url = item.get("url") or item.get("link")
            if not isinstance(url, str) or not _is_http_url(url):
                continue
            cleaned.append(
                {
                    "url": url,
                    "title": str(item.get("title") or "").strip(),
                    "snippet": redact(str(item.get("snippet") or item.get("description") or "").strip(), limit=400),
                }
            )
            if len(cleaned) >= capped:
                break
        return cleaned

    # ------------------------------------------------------------------ fetch --

    async def fetch(
        self, url: str, *, highlights: str | None = None, timeout: float | None = None
    ) -> dict[str, Any]:
        """Extract readable content from one page."""
        self._require_enabled()
        if not _is_http_url(url):
            # A search result handed us something that is not an http(s) URL.
            raise AdapterError(
                "Refusing to fetch a non-http(s) URL returned by search.",
                code="tinyfish_bad_url",
            )

        argv = [
            self._settings.tinyfish_cli, "fetch", "content", "get", url,
            "--format", "markdown",
            "--per-url-timeout-ms", str(int((timeout or self._settings.tinyfish_timeout_seconds) * 1000)),
        ]
        if highlights:
            argv += [
                "--highlights", highlights,
                "--max-snippets", "5",
                "--max-characters", str(MAX_FETCH_CHARS),
            ]

        payload = await self._invoke(argv)
        first = payload.get("results")
        if isinstance(first, list) and first:
            first = first[0]
        if not isinstance(first, dict):
            first = payload if isinstance(payload, dict) else {}

        text = ""
        if highlights:
            snippets = first.get("highlights") or first.get("snippets")
            if isinstance(snippets, list):
                text = "\n".join(str(item) for item in snippets if isinstance(item, (str, dict)))
        if not text:
            text = str(first.get("text") or first.get("markdown") or first.get("content") or "")
        return {
            "url": str(first.get("url") or url),
            "title": str(first.get("title") or "").strip(),
            "text": redact(text, limit=MAX_FETCH_CHARS),
        }

    # --------------------------------------------------------------- internals --

    def _require_enabled(self) -> None:
        if not self._settings.tinyfish_enabled:
            raise AdapterUnavailable(
                "TinyFish integration is disabled (AWE_TINYFISH_ENABLED=false).",
                code="tinyfish_disabled",
            )

    async def _invoke(self, argv: list[str]) -> Any:
        """Run a CLI command and decode its JSON output."""
        code, stdout, stderr = await run_command(
            argv, timeout=self._settings.tinyfish_timeout_seconds
        )
        if code != 0:
            raise AdapterError(
                f"`{argv[1]} {argv[2]}` exited {code}: {redact(stderr or stdout, limit=300)}",
                code="tinyfish_cli_failed",
                retryable=True,
            )
        try:
            return json.loads(stdout)
        except json.JSONDecodeError as exc:
            raise AdapterError(
                f"TinyFish returned non-JSON output: {redact(stdout, limit=160)}",
                code="tinyfish_bad_json",
            ) from exc


def _results_of(payload: Any) -> list[Any]:
    """Find the result array in whatever envelope the CLI produced."""
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for key in ("results", "items", "data", "web"):
            value = payload.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                for nested_key in ("results", "items"):
                    if isinstance(value.get(nested_key), list):
                        return value[nested_key]
    return []


def _is_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


__all__ = ["TinyFishAdapter"]
