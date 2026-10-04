"""Tests for how adapter failures are reported to the user."""

from __future__ import annotations

import time
from typing import Any

from app.adapters.base import AdapterError
from app.main import create_app
from app.schemas.task import TaskStatus


# --------------------------------------------------------------------------- #
# Adapter failures must reach the user with their own reason
# --------------------------------------------------------------------------- #

def _wait_for_terminal(client: Any, task_id: str, timeout: float = 20.0) -> dict:
    """Poll a task until it settles, then return its body."""
    deadline = time.monotonic() + timeout
    body: dict = {}
    while time.monotonic() < deadline:
        body = client.get(f"/api/tasks/{task_id}").json()
        if body["status"] in {"completed", "failed", "cancelled"}:
            return body
        time.sleep(0.05)
    raise AssertionError(f"task {task_id} never settled; last status={body.get('status')}")


def _client_for(settings: Any, run: Any) -> Any:
    from fastapi.testclient import TestClient

    async def factory(context: Any) -> None:
        await run(context)

    return TestClient(create_app(settings, orchestrator_factory=factory))


def test_adapter_failure_keeps_its_own_code_and_reason(settings: Any) -> None:
    """An AdapterError must not be flattened into a generic internal_error.

    AdapterError documents itself as "a failure the orchestrator can explain to
    the user" and carries the code, the reason and whether a retry could help.
    Reporting every one of them as "The run stopped unexpectedly" hid the cause
    of every adapter failure behind one opaque message.
    """

    async def run(context: Any) -> None:
        await context.transition(TaskStatus.STARTING)
        await context.transition(TaskStatus.RUNNING)
        await context.update(current_activity="Deciding step 2 of 30", progress=0.124)
        raise AdapterError(
            "The browser was still busy with another task after 120s.",
            code="browser_busy",
            retryable=True,
        )

    with _client_for(settings, run) as client:
        created = client.post("/api/tasks", json={"prompt": "Open http://127.0.0.1:8002"}).json()
        body = _wait_for_terminal(client, created["id"])

    assert body["status"] == "failed"
    assert body["error"]["code"] == "browser_busy"
    assert body["error"]["retryable"] is True
    assert "still busy" in body["error"]["message"]
    assert "stopped unexpectedly" not in body["error"]["message"]


def test_adapter_timeout_keeps_its_own_code(settings: Any) -> None:
    """A timed-out external command is a distinct, actionable failure."""

    async def run(context: Any) -> None:
        await context.transition(TaskStatus.STARTING)
        await context.transition(TaskStatus.RUNNING)
        raise AdapterError(
            "OpenClaw did not answer within 30s and was stopped.",
            code="adapter_timeout",
            retryable=True,
        )

    with _client_for(settings, run) as client:
        created = client.post("/api/tasks", json={"prompt": "Open http://127.0.0.1:8002"}).json()
        body = _wait_for_terminal(client, created["id"])

    assert body["error"]["code"] == "adapter_timeout"
    assert "within 30s" in body["error"]["message"]


def test_unexpected_exception_is_still_reported_as_internal_error(settings: Any) -> None:
    """The generic path must keep working, and stay generic."""

    async def run(context: Any) -> None:
        await context.transition(TaskStatus.STARTING)
        await context.transition(TaskStatus.RUNNING)
        raise RuntimeError("boom")

    with _client_for(settings, run) as client:
        created = client.post("/api/tasks", json={"prompt": "Open http://127.0.0.1:8002"}).json()
        body = _wait_for_terminal(client, created["id"])

    assert body["status"] == "failed"
    assert body["error"]["code"] == "internal_error"
    assert "RuntimeError" in body["error"]["message"]
