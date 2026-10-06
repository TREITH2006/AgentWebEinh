"""Extension-backed browser agent adapter.

``BrowserAdapter`` drives an in-process Playwright Chromium. This adapter drives
the **user's real Chrome** through the paired browser extension: the same
OBSERVE -> model action -> execute loop, but every page operation is a validated
``BrowserCommand`` sent over the WebSocket bridge instead of a Playwright call.

Reuse over rewrite:

* The observation/decision/execution vocabulary is inherited from
  :class:`~app.adapters.browser_adapter.BrowserAdapter`. ``ExtensionSession``
  offers the same surface as ``BrowserSession`` (current, text, headings,
  elements, click, fill, press, scroll, back, screenshot), so the inherited
  ``_observe``/``_decide``/``_execute``/``_resolve``/``_navigate`` methods work
  unchanged.
* ``run`` is overridden only where the session source differs: a bridge ``lease``
  replaces ``BrowserManager.session``. A task without a paired extension fails
  with ``browser_extension_unavailable`` instead of silently using Playwright.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
from typing import TYPE_CHECKING, Any

from ..browser.browser_bridge import BrowserBridge, BrowserPeer, ExtensionCommandError
from ..browser.browser_manager import (
    MAX_ELEMENTS,
    MAX_HEADINGS,
    MAX_TEXT_CHARS,
    ElementRef,
)
from ..config import Settings
from .base import AdapterError, IntegrationHealth
from .browser_adapter import (
    _PROGRESS_SPAN,
    _PROGRESS_STARTED,
    _STALL_STEP_LIMIT,
    BrowserAdapter,
    BrowserRunResult,
    _stalled_summary,
    _url_from_prompt,
)
from .browser_adapter import (
    ACTIONS as _ACTIONS,
)
from .browser_adapter import (
    normalize_action as _normalize_action,
)
from .ollama_adapter import OllamaAdapter

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..browser.browser_events import BrowserEventEmitter
    from ..core.cancellation import CancellationToken

logger = logging.getLogger("agentwebeinh.extension_adapter")

#: Where a `search` action goes, matching the native adapter.
SEARCH_ENDPOINT = "https://duckduckgo.com/html/?q={query}"


class ExtensionSession:
    """A browser that lives in the paired extension, one task at a time."""

    def __init__(
        self,
        bridge: BrowserBridge,
        peer: BrowserPeer,
        task_id: str,
        settings: Settings,
    ) -> None:
        self._bridge = bridge
        self._peer = peer
        self._task_id = task_id
        self._settings = settings
        self._action_seq = 0
        self._tab_ready = False

    # ------------------------------------------------------------- inspection --

    async def current(self) -> tuple[str | None, str | None]:
        data = await self._get_page()
        url = str(data.get("url") or "") or None
        title = str(data.get("title") or "") or None
        return url, title

    async def text(self, limit: int = MAX_TEXT_CHARS) -> str:
        data = await self._get_page()
        collapsed = " ".join(str(data.get("text") or "").split())
        return collapsed[:limit]

    async def headings(self, limit: int = MAX_HEADINGS) -> list[str]:
        data = await self._get_page()
        return [str(item) for item in (data.get("headings") or [])][:limit]

    async def elements(self, limit: int = MAX_ELEMENTS) -> list[ElementRef]:
        data = await self._get_page()
        refs: list[ElementRef] = []
        for entry in (data.get("elements") or [])[:limit]:
            if not isinstance(entry, dict):
                continue
            with contextlib.suppress(ValueError, TypeError):
                index = int(entry.get("index", 0))
            refs.append(
                ElementRef(
                    index=index,
                    selector=str(entry.get("selector", "")),
                    tag=str(entry.get("tag", "")),
                    role=str(entry.get("role")) if entry.get("role") else None,
                    text=str(entry.get("text", "")),
                )
            )
        return refs

    # ----------------------------------------------------------------- actions --

    async def goto(self, url: str) -> None:
        if not self._tab_ready:
            await self._cmd({"command": "NEW_TAB", "url": url})
            self._tab_ready = True
        else:
            await self._cmd({"command": "OPEN_URL", "url": url})

    async def click(self, selector: str) -> None:
        await self._cmd({"command": "CLICK", "target": {"strategy": "css", "selector": selector}})

    async def fill(self, selector: str, value: str) -> None:
        await self._cmd(
            {"command": "TYPE", "target": {"strategy": "css", "selector": selector}, "text": value}
        )

    async def press(self, key: str) -> None:
        # The extension's fixed command set has no key-press action. Surface that
        # honestly so the model clicks a submit button instead of guessing that
        # Enter worked.
        raise ExtensionCommandError(
            "UNSUPPORTED_OPERATION",
            f"The browser extension cannot press {key!r}; click the page's submit button instead.",
        )

    async def scroll(self, direction: str = "down") -> None:
        direction = direction if direction in ("down", "up") else "down"
        await self._cmd({"command": "SCROLL", "direction": direction, "amount": 800})
        await asyncio.sleep(0.4)

    async def back(self) -> None:
        await self._cmd({"command": "BACK"})

    # ---------------------------------------------------------------- capture --

    async def screenshot(self) -> tuple[bytes, int | None, int | None]:
        data = await self._cmd({"command": "SCREENSHOT", "format": "jpeg"})
        data_url = str(data.get("dataUrl") or "")
        raw = _decode_data_url(data_url)
        if not raw:
            raise ExtensionCommandError("SCREENSHOT_FAILURE", "The extension returned an empty screenshot.")
        return raw, None, None

    async def close(self) -> None:
        return

    # ---------------------------------------------------------------- plumbing --

    async def _get_page(self) -> dict[str, Any]:
        data = await self._cmd({"command": "GET_PAGE"})
        return data if isinstance(data, dict) else {}

    def _next_action_id(self) -> str:
        self._action_seq += 1
        return f"{self._task_id}-{self._action_seq}"

    async def _cmd(self, command: dict[str, Any]) -> dict[str, Any]:
        action_id = self._next_action_id()
        result = await self._bridge.execute(
            self._peer,
            self._task_id,
            action_id,
            command,
            timeout=self._settings.browser_extension_command_timeout_seconds,
        )
        if not result.get("success"):
            error = result.get("error") if isinstance(result.get("error"), dict) else {}
            raise ExtensionCommandError(
                str(error.get("code") or "browser_command_failed"),
                str(error.get("message") or "The browser extension reported a failure."),
            )
        data = result.get("data")
        return data if isinstance(data, dict) else {}


class ExtensionAdapter(BrowserAdapter):
    """Drives the paired extension on behalf of one task."""

    name = "extension"

    def __init__(self, settings: Settings, bridge: BrowserBridge, ollama: OllamaAdapter) -> None:
        super().__init__(settings, browser=None, ollama=ollama)  # type: ignore[arg-type]
        self._settings = settings
        self._bridge = bridge
        self._ollama = ollama

    # ----------------------------------------------------------------- health --

    def health(self) -> IntegrationHealth:
        return self._bridge.health()

    # -------------------------------------------------------------------- run --

    async def run(
        self,
        task_id: str,
        prompt: str,
        *,
        emitter: BrowserEventEmitter,
        token: CancellationToken,
        start_url: str | None = None,
        max_steps: int | None = None,
    ) -> BrowserRunResult:
        """Execute the task in the user's browser, bounded by steps and time."""
        result = BrowserRunResult()
        limit = max_steps or self._settings.max_orchestrator_steps
        deadline = asyncio.get_running_loop().time() + self._settings.task_timeout_seconds
        target = start_url or _url_from_prompt(prompt)

        async with self._bridge.lease(
            task_id, self._settings.browser_extension_wait_seconds
        ) as peer:
            await emitter.log(
                "Driving the paired Chrome extension.",
                detail=f"Browser {peer.browser_id} ({peer.display_name}) is executing in real Chrome.",
            )
            session = ExtensionSession(self._bridge, peer, task_id, self._settings)

            try:
                if target:
                    result.record_action("Opened the URL from the task", url=target)
                    await self._navigate(session, emitter, target, result)
                elif not await self._start_from_search(session, emitter, prompt, result):
                    result.summary = (
                        "The model could not choose a starting search query, so no browsing "
                        "was performed in the paired browser."
                    )
                    return result

                await emitter.progress("Reading the page", _PROGRESS_STARTED)

                last_error: str | None = None
                stalled_steps = 0
                for step in range(1, limit + 1):
                    result.steps = step
                    _check_cancelled(token)
                    if asyncio.get_running_loop().time() > deadline:
                        result.summary = "Stopped: the task exceeded its time budget."
                        return result

                    await emitter.progress(
                        f"Deciding step {step} of {limit}", _progress_for_step(step, limit)
                    )
                    observation = await self._observe(session, emitter)
                    try:
                        decision = await self._decide(
                            prompt, observation, result, step, limit, last_error
                        )
                    except AdapterError as exc:
                        if exc.code != "model_timeout" or not exc.retryable:
                            raise
                        logger.info("step_model_timeout step=%s limit=%s", step, limit)
                        await emitter.log(
                            "The model took too long to answer that step.",
                            detail="Retrying with a shorter question.",
                        )
                        last_error = (
                            "Your previous answer did not arrive in time. Answer in the "
                            "shortest form possible: one JSON object, no extra prose."
                        )
                        stalled_steps += 1
                        if stalled_steps >= _STALL_STEP_LIMIT:
                            result.summary = _stalled_summary(result, step)
                            return result
                        continue
                    last_error = None

                    if decision is None:
                        result.summary = "The model stopped producing usable actions."
                        return result

                    action = _normalize_action(str(decision.get("action") or ""))
                    if action not in _ACTIONS:
                        logger.info("ignoring_unsupported_action step=%s action=%r", step, action)
                        last_error = (
                            f"Unsupported action {action!r}. Choose one of: {', '.join(sorted(_ACTIONS))}."
                        )
                        stalled_steps += 1
                        if stalled_steps >= _STALL_STEP_LIMIT:
                            result.summary = _stalled_summary(result, step)
                            return result
                        continue

                    before = result.evidence_count()
                    outcome = await self._execute(session, emitter, action, decision, result, token)
                    if outcome.stop:
                        result.summary = str(decision.get("summary") or "").strip() or "Task finished."
                        if not result.findings and result.summary:
                            result.add_finding("Result", result.summary)
                        return result
                    if outcome.error:
                        last_error = outcome.error

                    after = result.evidence_count()
                    if after == before:
                        stalled_steps += 1
                    else:
                        stalled_steps = 0
                    if stalled_steps >= _STALL_STEP_LIMIT:
                        logger.info(
                            "extension_run_stalled task_id=%s step=%s", task_id, step
                        )
                        await emitter.log(
                            "Stopping: the last steps produced no new evidence.",
                            detail=(
                                f"{len(result.findings)} finding(s) were collected before the "
                                "agent stopped making progress."
                            ),
                        )
                        result.summary = _stalled_summary(result, step)
                        return result

                result.summary = _stalled_summary(result, limit)
                return result
            except asyncio.CancelledError:
                with contextlib.suppress(Exception):
                    await self._bridge.cancel_task(peer, task_id)
                raise


def _progress_for_step(step: int, limit: int) -> float:
    ratio = min(max((step - 1) / max(limit - 1, 1), 0.0), 1.0)
    return round(_PROGRESS_STARTED + _PROGRESS_SPAN * ratio, 3)


def _check_cancelled(token: CancellationToken) -> None:
    token.raise_if_cancelled()


def _decode_data_url(data_url: str) -> bytes | None:
    """Extract the raw bytes from ``data:image/jpeg;base64,....``."""
    if not data_url.startswith("data:"):
        return None
    marker = ","
    comma = data_url.find(marker)
    if comma < 0:
        return None
    try:
        return base64.b64decode(data_url[comma + 1 :])
    except ValueError:  # pragma: no cover - defensive
        return None


__all__ = ["SEARCH_ENDPOINT", "ExtensionAdapter", "ExtensionSession"]
