"""The browser agent loop, driven end to end with stub collaborators.

These cover the failure that actually shipped: a model that kept re-emitting the
same finding until the whole task budget was spent. The loop is exercised here
rather than through Playwright, so the stall guard is proven deterministically
instead of by waiting out a real 15-minute task.
"""

from __future__ import annotations

import contextlib
from typing import Any
from unittest import mock

import pytest

from app.adapters.browser_adapter import BrowserAdapter, _STALL_STEP_LIMIT
from app.config import settings_override
from app.core.cancellation import CancellationToken


class _StubSession:
    """The slice of BrowserSession the loop touches, with a real page model."""

    def __init__(self) -> None:
        self.url = "http://127.0.0.1:8002/"
        self.title = "AgentWebEinh Local Test"
        self.heading = "Local Browser Test Passed"
        self.goto_calls: list[str] = []
        self.scroll_calls: list[str] = []

    async def current(self) -> tuple[str, str]:
        return self.url, self.title

    async def text(self, limit: int = 0) -> str:
        return f"{self.heading} Served locally on the Windows PC for the test."

    async def headings(self, limit: int = 0) -> list[str]:
        return [f"h1: {self.heading}"]

    async def elements(self, limit: int = 0) -> list[Any]:
        return []

    async def screenshot(self) -> tuple[bytes, int, int]:
        return b"\xff\xd8\xff\xe0stub", 800, 600

    async def goto(self, url: str, *, wait_until: str = "load", timeout: int = 0) -> None:
        self.goto_calls.append(url)
        # Browsers normalise a bare origin to include the root path.
        self.url = url if url.endswith("/") else f"{url}/"

    async def scroll(self, direction: str = "down") -> None:
        self.scroll_calls.append(direction)


def _adapter(decisions: list[dict[str, Any]], *, max_steps: int = 30) -> tuple[BrowserAdapter, _StubSession]:
    """A wired adapter whose model returns ``decisions`` in order."""
    settings = settings_override(max_orchestrator_steps=max_steps)
    session = _StubSession()

    @contextlib.asynccontextmanager
    async def _session(_task_id: str):
        yield session

    browser = mock.Mock(active_session_count=0)
    browser.session = _session

    ollama = mock.Mock()
    ollama.chat_json = mock.AsyncMock(side_effect=decisions)
    return BrowserAdapter(settings, browser, ollama), session


def _emitter() -> mock.AsyncMock:
    return mock.AsyncMock()


@pytest.mark.asyncio
async def test_run_completes_when_the_model_records_then_finishes():
    adapter, session = _adapter(
        [
            {"action": "finding", "label": "page_title", "value": "AgentWebEinh Local Test"},
            {"action": "finding", "label": "main_heading", "value": "Local Browser Test Passed"},
            {"action": "done", "summary": "Reported the title and heading."},
        ]
    )

    result = await adapter.run(
        "task_1",
        "Open http://127.0.0.1:8002 and report the page title and the main heading.",
        emitter=_emitter(),
        token=CancellationToken("t"),
    )

    assert result.summary == "Reported the title and heading."
    assert [f.label for f in result.findings] == ["page_title", "main_heading"]
    # The prompt URL must be visited without the model having to ask for it.
    assert session.goto_calls == ["http://127.0.0.1:8002"]
    # Every finding must say where it came from.
    assert {f.source_url for f in result.findings} == {"http://127.0.0.1:8002/"}
    # A report that lists no actions reads as though the agent never moved.
    assert [a.label for a in result.actions] == ["Opened the URL from the task"]


@pytest.mark.asyncio
async def test_run_stops_instead_of_looping_on_one_repeated_finding():
    """The shipped bug: the same finding re-emitted until the task timed out."""
    repeated = {"action": "finding", "label": "page_title", "value": "AgentWebEinh Local Test"}
    adapter, _ = _adapter([dict(repeated) for _ in range(30)])

    result = await adapter.run(
        "task_2",
        "Open http://127.0.0.1:8002 and report the page title.",
        emitter=_emitter(),
        token=CancellationToken("t"),
    )

    assert len(result.findings) == 1, "a duplicate must never pad the report"
    # One step to record it, then _STALL_STEP_LIMIT fruitless ones.
    assert result.steps <= _STALL_STEP_LIMIT + 1
    assert "stopped making progress" in result.summary
    assert "complete" not in result.summary.lower()


@pytest.mark.asyncio
async def test_run_ends_with_what_it_found_when_the_model_never_says_done():
    adapter, _ = _adapter(
        [
            {"action": "finding", "label": "page_title", "value": "AgentWebEinh Local Test"},
            *[{"action": "scroll", "direction": "down"} for _ in range(30)],
        ]
    )

    result = await adapter.run(
        "task_3",
        "Open http://127.0.0.1:8002 and report the page title.",
        emitter=_emitter(),
        token=CancellationToken("t"),
    )

    # A scroll is a real action, but repeating it teaches the agent nothing.
    assert result.steps > _STALL_STEP_LIMIT, "a scroll alone must not trip the guard"
    assert [f.label for f in result.findings] == ["page_title"]
    assert "stopped making progress" in result.summary


@pytest.mark.asyncio
async def test_a_duplicate_is_refused_with_a_message_rather_than_silently_dropped():
    adapter, _ = _adapter(
        [
            {"action": "finding", "label": "page_title", "value": "AgentWebEinh Local Test"},
            {"action": "finding", "label": "page_title", "value": "AgentWebEinh Local Test"},
            {"action": "done", "summary": "Done."},
        ]
    )

    await adapter.run(
        "task_4",
        "Open http://127.0.0.1:8002 and report the page title.",
        emitter=_emitter(),
        token=CancellationToken("t"),
    )

    prompts = [call.args[1] for call in adapter._ollama.chat_json.call_args_list]
    assert any("already recorded" in prompt for prompt in prompts), (
        "the model must be told why its finding was refused"
    )
    assert any('"action":"done"' in prompt for prompt in prompts), (
        "once findings exist, the model must be pushed to finish"
    )


@pytest.mark.asyncio
async def test_run_reaches_the_step_limit_without_claiming_success():
    adapter, _ = _adapter(
        [{"action": "scroll", "direction": "down"} for _ in range(30)], max_steps=4
    )

    result = await adapter.run(
        "task_5",
        "Open http://127.0.0.1:8002 and scroll forever.",
        emitter=_emitter(),
        token=CancellationToken("t"),
    )

    assert result.steps <= 4
    assert "stopped making progress" in result.summary

@pytest.mark.asyncio
async def test_a_slow_model_call_does_not_throw_away_evidence_already_collected():
    """A >step_timeout call used to fail the whole task outright."""
    from app.adapters.base import AdapterError

    adapter, _ = _adapter(
        [
            {"action": "finding", "label": "page_title", "value": "AgentWebEinh Local Test"},
            AdapterError("The model did not respond in time.", code="model_timeout", retryable=True),
            AdapterError("The model did not respond in time.", code="model_timeout", retryable=True),
            AdapterError("The model did not respond in time.", code="model_timeout", retryable=True),
        ]
    )

    result = await adapter.run(
        "task_6",
        "Open http://127.0.0.1:8002 and report the page title.",
        emitter=_emitter(),
        token=CancellationToken("t"),
    )

    assert [f.label for f in result.findings] == ["page_title"]
    assert "stopped making progress" in result.summary


@pytest.mark.asyncio
async def test_a_non_timeout_adapter_error_still_fails_the_task():
    """Tolerance must not swallow a genuine integration failure."""
    from app.adapters.base import AdapterError

    adapter, _ = _adapter(
        [AdapterError("Ollama is unreachable.", code="ollama_unreachable", retryable=True)]
    )

    with pytest.raises(AdapterError):
        await adapter.run(
            "task_7",
            "Open http://127.0.0.1:8002.",
            emitter=_emitter(),
            token=CancellationToken("t"),
        )
