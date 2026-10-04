"""OpenClaw adapter.

Deliberate constraints, each of which exists to avoid breaking a working setup:

* **Documented CLI only.** Uses ``openclaw health --json`` and
  ``openclaw agent --json``. The gateway's raw WebSocket RPC is never spoken to:
  it is an internal, unauthenticated-by-default protocol and pinning to it would
  break on the next OpenClaw release.
* **Never delivers anywhere.** ``--deliver`` is never passed. The CLI defaults it
  to ``false``; the agent's reply is read from stdout and discarded.
* **Never touches the user's sessions.** Each run is addressed to its own
  ``agent:<id>:awe-<task_id>`` session key, so a task cannot append to
  ``agent:main:main`` — the session wired to the user's Telegram chat.
* **Never mutates configuration.** No ``config set``, no ``configure``, no
  ``gateway run``. The adapter is a read-only client of an already-running
  gateway.
"""

from __future__ import annotations

import contextlib
import json
import logging
from pathlib import Path
from typing import Any

from ..config import DATA_DIR, Settings
from .base import (
    AdapterError,
    AdapterUnavailable,
    IntegrationHealth,
    redact,
    run_command,
)

logger = logging.getLogger("agentwebeinh.openclaw")

#: Where prompts are staged for ``--message-file``. Project-local and transient.
PROMPT_DIR = DATA_DIR / "openclaw"

#: Keys that have carried the agent's reply text across OpenClaw versions.
_REPLY_KEYS = ("result", "reply", "output", "text", "response", "content", "message")

#: How far the envelope walker descends. Deep enough for
#: ``result.payloads[].text``, shallow enough that a large nested blob of
#: telemetry is not walked on every reply.
_MAX_REPLY_DEPTH = 6


class OpenClawAdapter:
    """Read-only client for a running OpenClaw gateway."""

    name = "openclaw"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    # ----------------------------------------------------------------- health --

    async def health(self) -> IntegrationHealth:
        if not self._settings.openclaw_enabled:
            return IntegrationHealth(
                self.name, "disabled", "OpenClaw integration is disabled (AWE_OPENCLAW_ENABLED=false)."
            )

        timeout = self._settings.openclaw_health_timeout_ms / 1000.0
        try:
            code, stdout, stderr = await run_command(
                [self._settings.openclaw_cli, "health", "--json"], timeout=timeout
            )
        except AdapterUnavailable as exc:
            return IntegrationHealth(self.name, "down", str(exc))
        except AdapterError as exc:
            return IntegrationHealth(self.name, "down", str(exc))

        if code != 0:
            detail = redact(stderr or stdout or "no output", limit=200)
            return IntegrationHealth(self.name, "down", f"`openclaw health` exited {code}: {detail}")

        payload = _parse_json_object(stdout)
        info: dict[str, Any] = {"gateway": self._settings.openclaw_gateway_url}
        if payload:
            info["keys"] = sorted(payload)[:12]
            for key in ("version", "status", "uptime", "channels"):
                if key in payload:
                    info[key] = payload[key]
            ok = bool(payload.get("ok", True))
            state = "up" if ok else "degraded"
            detail = "Gateway reachable." if ok else "Gateway reported ok=false."
            return IntegrationHealth(self.name, state, detail, info)

        return IntegrationHealth(self.name, "degraded", "Gateway responded but not with JSON.", info)

    # -------------------------------------------------------------- agent run --

    def session_key(self, task_id: str) -> str:
        """Per-task session key. Never collides with a human's session."""
        return f"agent:{self._settings.openclaw_agent_id}:{self._settings.openclaw_session_prefix}-{task_id}"

    async def run_agent(self, task_id: str, prompt: str, *, timeout: float | None = None) -> str:
        """Run one agent turn in a task-scoped session and return its reply text.

        The prompt is staged on disk and passed via ``--message-file`` so long
        prompts cannot exceed the OS argv limit and so page-derived text is never
        subject to shell quoting (no shell is used at all).
        """
        if not self._settings.openclaw_enabled:
            raise AdapterUnavailable("OpenClaw integration is disabled.", code="openclaw_disabled")

        deadline = timeout or self._settings.openclaw_agent_timeout_seconds
        prompt_path = await self._stage_prompt(task_id, prompt)
        argv = [
            self._settings.openclaw_cli,
            "agent",
            "--session-key", self.session_key(task_id),
            "--message-file", str(prompt_path),
            "--timeout", str(int(deadline)),
            "--json",
            # --deliver is intentionally omitted: replies must never be sent to a channel.
        ]
        try:
            code, stdout, stderr = await run_command(argv, timeout=deadline + 15.0)
        finally:
            with contextlib.suppress(OSError):
                prompt_path.unlink(missing_ok=True)

        if code != 0:
            detail = redact(stderr or stdout or "no output", limit=400)
            raise AdapterError(
                f"`openclaw agent` exited {code}: {detail}",
                code="openclaw_agent_failed",
                retryable=True,
            )

        return _extract_reply(stdout)

    async def _stage_prompt(self, task_id: str, prompt: str) -> Path:
        """Write the prompt to a project-local file for ``--message-file``."""
        directory = PROMPT_DIR
        directory.mkdir(parents=True, exist_ok=True)
        safe_id = "".join(char for char in task_id if char.isalnum() or char in "-_")[:64] or "task"
        path = directory / f"{safe_id}.prompt.txt"
        # 4 MiB is the documented CLI ceiling; stay well under it.
        path.write_text(prompt[: 1_000_000], encoding="utf-8")
        return path


def _parse_json_object(raw: str) -> dict[str, Any] | None:
    text = raw.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        # The CLI sometimes prefixes a human-readable line before the JSON.
        start, end = text.find("{"), text.rfind("}")
        if start == -1 or end <= start:
            return None
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return parsed if isinstance(parsed, dict) else None


def _extract_reply(raw: str) -> str:
    """Pull the agent's reply text out of whatever shape the CLI returned."""
    payload = _parse_json_object(raw)
    if payload is None:
        text = raw.strip()
        if not text:
            raise AdapterError("OpenClaw returned an empty response.", code="openclaw_empty")
        return text

    texts = _collect_reply_texts(payload)
    if not texts:
        # Nothing matched a known key: return the JSON so the orchestrator can
        # still show the operator something concrete instead of failing.
        return json.dumps(payload, ensure_ascii=False)
    return "\n".join(texts)


def _collect_reply_texts(payload: dict[str, Any], depth: int = 0) -> list[str]:
    """Every reply-shaped string in the envelope, in document order.

    ``openclaw agent --json`` returns the agent's actual words as
    ``result.payloads[].text`` — an array of objects nested two levels down. A
    walker that only descends into objects never reaches it, so extraction found
    nothing and fell back to re-serialising the whole envelope. The report parser
    then read that JSON as prose and split it on the first colon, which is how a
    finding ended up labelled ``{"runId"`` and valued with the run id.

    Arrays are therefore walked alongside objects, and each ``payloads`` entry
    contributes its own text so a multi-message run reports all of it.
    """
    if depth > _MAX_REPLY_DEPTH:
        return []

    found: list[str] = []
    visited: set[str] = set()

    # Known reply keys first, so an explicit `text`/`result` wins over an
    # incidental string that happens to sit deeper in the envelope.
    for key in _REPLY_KEYS:
        if key not in payload:
            continue
        visited.add(key)
        found.extend(_texts_from(payload[key], depth + 1))

    for key, value in payload.items():
        if key in visited:
            continue
        if isinstance(value, (dict, list)):
            found.extend(_texts_from(value, depth + 1))

    return found


def _texts_from(value: Any, depth: int) -> list[str]:
    """Reply strings held by one value: a string, an object, or an array."""
    if depth > _MAX_REPLY_DEPTH:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, dict):
        return _collect_reply_texts(value, depth)
    if isinstance(value, list):
        found: list[str] = []
        for item in value:
            found.extend(_texts_from(item, depth))
        return found
    return []


__all__ = ["OpenClawAdapter"]
