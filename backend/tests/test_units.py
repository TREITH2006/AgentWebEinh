"""Unit tests for logic that has no HTTP surface.

These are the pieces where a bug is silent: a report that loses the only evidence
a run produced, a frame stream that starves one of two viewers, or a state machine
that permits a task to run backwards.
"""

from __future__ import annotations

import asyncio
from unittest import mock

import pytest

from app.adapters.browser_adapter import BrowserRunResult
from app.browser.frame_manager import FrameManager
from app.config import Settings, settings_override
from app.core.orchestrator import _ingest_openclaw_reply
from app.core.state_machine import (
    InvalidTransition,
    can_transition,
    ensure_transition,
    is_terminal,
)
from app.schemas.task import TaskStatus
from app.utils.ids import is_ulid_like, new_event_id, new_task_id

# --------------------------------------------------------------- OpenClaw parse --


def test_openclaw_reply_becomes_findings_and_sources() -> None:
    """A reply in the documented shape must reach the report as findings."""
    result = BrowserRunResult()

    structured = _ingest_openclaw_reply(
        result,
        "Monthly price: 42 USD per seat (https://example.com/pricing)\n"
        "Support: included, no extra cost (https://example.com/support)\n",
    )

    assert structured is True
    assert [f.label for f in result.findings] == ["Monthly price", "Support"]
    assert result.findings[0].value == "42 USD per seat"
    assert result.findings[0].source_url == "https://example.com/pricing"
    # Sourced findings must also register as pages, or they vanish from `sources`.
    assert [page["url"] for page in result.pages_visited] == [
        "https://example.com/pricing",
        "https://example.com/support",
    ]


def test_openclaw_reply_bullets_and_bare_lines_are_accepted() -> None:
    result = BrowserRunResult()

    structured = _ingest_openclaw_reply(
        result, "- Bullet label: bullet value\n* no colon on this line\n"
    )

    assert structured is True
    assert result.findings[0].label == "Bullet label"
    # A line with no "label: value" split is still evidence, not a reason to drop it.
    assert result.findings[1].value == "no colon on this line"
    assert result.findings[1].source_url is None


def test_unstructured_openclaw_reply_is_kept_whole() -> None:
    """An unparseable reply is the only evidence the run produced: keep it."""
    result = BrowserRunResult()

    structured = _ingest_openclaw_reply(result, "Everything is on one line")

    assert structured is False
    assert len(result.findings) == 1
    assert result.findings[0].value == "Everything is on one line"


def test_empty_openclaw_reply_adds_nothing() -> None:
    result = BrowserRunResult()

    assert _ingest_openclaw_reply(result, "   \n  \n") is False
    assert result.findings == []


# ------------------------------------------------------------------ frame fan-out --


def _frame_settings() -> Settings:
    return settings_override(
        browser_max_screenshot_bytes=1_000,
        browser_frame_interval_ms=200,
    )


async def test_every_subscriber_receives_the_same_frame() -> None:
    """Two viewers of one task must both be served; neither may starve the other."""
    manager = FrameManager(_frame_settings())
    task_id = "task-fanout"

    first = asyncio.create_task(_collect(manager, task_id))
    second = asyncio.create_task(_collect(manager, task_id))
    # Let both streams register before anything is published.
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert manager.stats()["active_subscribers"] == 2

    await manager.publish(task_id, b"jpeg-bytes-1")

    assert await asyncio.wait_for(first, timeout=2) == b"jpeg-bytes-1"
    assert await asyncio.wait_for(second, timeout=2) == b"jpeg-bytes-1"


async def test_a_closed_stream_deregisters_its_subscriber() -> None:
    """A viewer that goes away must not leave a queue that frames pile into."""
    manager = FrameManager(_frame_settings())
    task_id = "task-leaving"

    stream = manager.mjpeg_stream(task_id)
    # The generator body only runs on first ``__anext__``, so the frame published
    # beforehand is replayed to the client from ``_latest`` on connect.
    await manager.publish(task_id, b"jpeg-bytes")
    chunk = await asyncio.wait_for(stream.__anext__(), timeout=2)

    assert b"jpeg-bytes" in chunk
    assert manager.stats()["active_subscribers"] == 1

    await stream.aclose()
    assert manager.stats()["active_subscribers"] == 0


async def _collect(manager: FrameManager, task_id: str) -> bytes:
    """Take the first frame off an MJPEG stream and return its payload."""
    async for chunk in manager.mjpeg_stream(task_id):
        # Strip the multipart headers to get back to the JPEG bytes.
        return chunk.split(b"\r\n\r\n", 1)[1].rstrip(b"\r\n")
    raise AssertionError("stream ended without a frame")


async def test_oversized_frame_is_rejected_and_not_published() -> None:
    """A corrupt JPEG would make the frontend's <img> fail and blame the stream."""
    manager = FrameManager(_frame_settings())

    assert await manager.publish("task-big", b"x" * 1_001) is None
    assert await manager.latest("task-big") is None


async def test_clear_removes_the_latest_frame() -> None:
    """Terminal tasks clear the view so no stale frame sits next to a report."""
    manager = FrameManager(_frame_settings())
    await manager.publish("task-done", b"jpeg")

    await manager.clear("task-done")

    assert await manager.latest("task-done") is None


# ----------------------------------------------------------------- state machine --


def test_only_terminal_statuses_are_terminal() -> None:
    assert is_terminal(TaskStatus.COMPLETED)
    assert is_terminal(TaskStatus.FAILED)
    assert is_terminal(TaskStatus.CANCELLED)
    for status in (TaskStatus.READY, TaskStatus.QUEUED, TaskStatus.STARTING,
                   TaskStatus.RUNNING, TaskStatus.AWAITING_APPROVAL):
        assert not is_terminal(status)


def test_happy_path_transitions_are_allowed() -> None:
    assert can_transition(TaskStatus.QUEUED, TaskStatus.STARTING)
    assert can_transition(TaskStatus.STARTING, TaskStatus.RUNNING)
    assert can_transition(TaskStatus.RUNNING, TaskStatus.COMPLETED)
    assert can_transition(TaskStatus.QUEUED, TaskStatus.CANCELLED)
    assert can_transition(TaskStatus.RUNNING, TaskStatus.FAILED)


def test_a_task_can_never_run_backwards() -> None:
    assert not can_transition(TaskStatus.RUNNING, TaskStatus.QUEUED)
    assert not can_transition(TaskStatus.COMPLETED, TaskStatus.RUNNING)
    assert not can_transition(TaskStatus.FAILED, TaskStatus.STARTING)


def test_invalid_transition_raises_rather_than_corrupting_state() -> None:
    with pytest.raises(InvalidTransition):
        ensure_transition(TaskStatus.COMPLETED, TaskStatus.RUNNING)


def test_same_status_transition_is_tolerated() -> None:
    """Workers re-assert state defensively; a no-op assertion is not an error."""
    ensure_transition(TaskStatus.RUNNING, TaskStatus.RUNNING)


# --------------------------------------------------------------------------- ids --


def test_task_ids_are_sortable_ulids_with_the_documented_prefix() -> None:
    task_id = new_task_id()

    assert is_ulid_like(task_id, "task")
    assert task_id.startswith("task_")
    # Both prefix spellings are accepted.
    assert is_ulid_like(task_id, "task_")
    assert is_ulid_like(new_event_id(), "evt")
    assert not is_ulid_like(task_id, "evt")
    assert not is_ulid_like("task_short", "task")


def test_ids_sort_by_creation_time() -> None:
    """Ordering is guaranteed per millisecond, not per call.

    The random half of the id breaks ties, so two ids minted inside the same
    millisecond may sort either way. That is fine for the task list, which falls
    back to ``created_at``; what must hold is that a later id never sorts earlier.
    """
    with mock.patch("app.utils.ids.time.time", return_value=1_700_000_000.0):
        earlier = new_task_id()
    with mock.patch("app.utils.ids.time.time", return_value=1_700_000_000.5):
        later = new_task_id()

    assert earlier < later
