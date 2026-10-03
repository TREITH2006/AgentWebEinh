"""Contract tests: the wire behaviour the frontend is written against.

Everything here runs through the real routers, repositories and state machine; only
the orchestrator (the component that would launch a browser or a model) is stubbed.
A failure means the frontend would break, not merely that an internal detail moved.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app
from app.schemas.task import TaskStatus
from conftest import STUB_REPORT

#: Generous upper bound for a stubbed run to reach a terminal status.
TERMINAL_TIMEOUT_SECONDS = 15.0
#: Statuses after which no further updates are expected.
TERMINAL_STATUSES = {
    TaskStatus.COMPLETED.value,
    TaskStatus.FAILED.value,
    TaskStatus.CANCELLED.value,
}


# ------------------------------------------------------------------- utilities --


def _submit(client: Any, prompt: str, client_request_id: str | None = None) -> Any:
    body: dict[str, Any] = {"prompt": prompt}
    if client_request_id is not None:
        body["clientRequestId"] = client_request_id
    return client.post("/api/tasks", json=body)


def _wait_for_terminal(client: Any, task_id: str) -> dict[str, Any]:
    """Poll until the task settles.

    The worker pool runs in the app's event loop, so the test cannot await it; it
    has to drive the HTTP surface and wait, exactly as the frontend does.
    """
    deadline = time.monotonic() + TERMINAL_TIMEOUT_SECONDS
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/api/tasks/{task_id}")
        assert response.status_code == 200, response.text
        last = response.json()
        if last["status"] in TERMINAL_STATUSES:
            return last
        time.sleep(0.02)
    pytest.fail(f"task {task_id} never settled; last status={last.get('status')!r}")


def _completed_task(client: Any, prompt: str = "Summarise the pricing page") -> dict[str, Any]:
    response = _submit(client, prompt)
    assert response.status_code == 201, response.text
    task = _wait_for_terminal(client, response.json()["id"])
    assert task["status"] == TaskStatus.COMPLETED.value, task
    return task


# ------------------------------------------------------------------ submission --


def test_create_returns_201_queued_without_waiting_for_a_run(client: Any) -> None:
    """The frontend navigates to the workspace immediately, so this must not block."""
    response = _submit(client, "Find the cheapest plan")

    assert response.status_code == 201, response.text
    body = response.json()
    assert set(body) == {"id", "status", "created_at"}
    assert body["status"] in {TaskStatus.QUEUED.value, TaskStatus.STARTING.value}
    assert body["id"].startswith("task_")


def test_repeating_a_client_request_id_replays_instead_of_resubmitting(client: Any) -> None:
    """A double-clicked submit must not start a second browser run."""
    first = _submit(client, "Only run me once", client_request_id="req-abc")
    second = _submit(client, "Only run me once", client_request_id="req-abc")

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]

    _wait_for_terminal(client, first.json()["id"])
    listing = client.get("/api/tasks").json()
    assert listing["total"] == 1


def test_prompt_is_trimmed_and_bounded(client: Any) -> None:
    """Whitespace-only text is not a task; the UI trims, the API must not assume."""
    assert _submit(client, "   \n  ").status_code == 422
    assert _submit(client, "x" * 2_001).status_code == 422

    accepted = _submit(client, "   Summarise this   ")
    assert accepted.status_code == 201
    task = client.get(f"/api/tasks/{accepted.json()['id']}").json()
    assert task["prompt"] == "Summarise this"


# --------------------------------------------------------------------- readback --


def test_completed_task_exposes_the_committed_report(client: Any) -> None:
    """The report is committed before the terminal event, so it is there on read."""
    task = _completed_task(client)

    report = task["report"]
    assert report["summary"] == STUB_REPORT["summary"]
    # Round-tripping through the stored payload fills optional keys with None, so
    # compare the fields the frontend actually renders.
    assert report["findings"][0]["label"] == "Stub finding"
    assert report["findings"][0]["value"] == STUB_REPORT["findings"][0]["value"]
    assert report["findings"][0]["sourceUrl"] == "https://example.com/stub"
    assert report["sources"][0]["url"] == "https://example.com/stub"
    assert report["actions"][0]["status"] == "performed"
    assert report["limitations"] == STUB_REPORT["limitations"]

    assert task["progress"] == 1.0
    assert task["started_at"] is not None
    assert task["completed_at"] is not None


def test_list_is_newest_first_and_reports_totals(client: Any) -> None:
    first = _completed_task(client, "First task")
    second = _completed_task(client, "Second task")

    body = client.get("/api/tasks").json()

    assert body["total"] == 2
    assert [item["id"] for item in body["items"]] == [second["id"], first["id"]]


def test_list_filters_by_status_and_search(client: Any) -> None:
    priced = _completed_task(client, "Pricing research")
    other = _completed_task(client, "Something else")

    completed = client.get("/api/tasks?status=completed").json()
    assert completed["total"] == 2
    assert {item["id"] for item in completed["items"]} == {priced["id"], other["id"]}

    by_search = client.get("/api/tasks?search=pricing").json()
    assert [item["id"] for item in by_search["items"]] == [priced["id"]]

    # A status nothing matches is an empty page, not an error.
    assert client.get("/api/tasks?status=failed").json()["items"] == []


def test_list_pagination_bounds(client: Any) -> None:
    for index in range(3):
        _completed_task(client, f"Paged task {index}")

    page = client.get("/api/tasks?limit=2&offset=0").json()
    assert len(page["items"]) == 2
    assert page["total"] == 3

    second_page = client.get("/api/tasks?limit=2&offset=2").json()
    assert len(second_page["items"]) == 1
    # Disjoint pages, ordered: the offset must actually skip.
    assert not {item["id"] for item in page["items"]} & {
        item["id"] for item in second_page["items"]
    }

    assert client.get("/api/tasks?limit=0").status_code == 422
    assert client.get("/api/tasks?limit=201").status_code == 422
    assert client.get("/api/tasks?offset=-1").status_code == 422


# ----------------------------------------------------------------------- events --


def test_event_history_replays_the_run(client: Any) -> None:
    """Events must be replayable for a client that attaches after the fact."""
    task = _completed_task(client)

    response = client.get(f"/api/tasks/{task['id']}/events")
    assert response.status_code == 200
    events = response.json()

    assert events, "a completed run must leave a replayable trail"
    types = [event["type"] for event in events]
    assert "task_received" in types
    assert "agent_started" in types
    assert "task_completed" in types
    # Ids are stable: the feed de-duplicates by id.
    assert len({event["id"] for event in events}) == len(events)
    # Ordered oldest first.
    assert [event["at"] for event in events] == sorted(event["at"] for event in events)
    # The terminal event is last: nothing may follow completion.
    assert types[-1] == "task_completed"


def test_events_can_be_limited(client: Any) -> None:
    task = _completed_task(client)

    limited = client.get(f"/api/tasks/{task['id']}/events?limit=1").json()

    assert len(limited) == 1


def test_unknown_task_events_are_404(client: Any) -> None:
    assert client.get("/api/tasks/nope/events").status_code == 404


# ------------------------------------------------------------------------ frames --


def test_frame_urls_are_absolute_and_present_before_any_frame(client: Any) -> None:
    """A URL that appears and disappears would flicker in the UI."""
    task = _completed_task(client)

    body = client.get(f"/api/tasks/{task['id']}/frames").json()

    assert body["frames_url"].startswith("http")
    assert body["snapshot_url"].startswith("http")
    assert body["frames_url"].endswith("/stream.mjpeg")
    assert body["snapshot_url"].endswith("/frame.jpg")
    # The stub never captured a frame, and that is not an error.
    assert body["captured_at"] is None


def test_snapshot_without_a_frame_is_404_but_not_an_error_envelope(client: Any) -> None:
    """404 here distinguishes 'not started yet' from 'the stream died'."""
    task = _completed_task(client)

    response = client.get(f"/api/tasks/{task['id']}/frame.jpg")

    assert response.status_code == 404
    # ``no-store`` must be present; the middleware may append further directives.
    assert "no-store" in response.headers["cache-control"]


# ------------------------------------------------------------------- statistics --


def test_stats_reflect_completed_runs(client: Any) -> None:
    _completed_task(client, "One")
    _completed_task(client, "Two")

    body = client.get("/api/stats?range=7d").json()

    assert body["total_tasks"] == 2
    assert body["completed_tasks"] == 2
    assert body["failed_tasks"] == 0
    # A 0..1 ratio: the frontend renders it with the same helper as ``progress``.
    assert body["success_rate"] == 1.0
    assert body["total_tasks"] == sum(bucket["performed"] for bucket in body["buckets"])


# --------------------------------------------------------------------- websocket --


def test_websocket_on_a_finished_task_sends_a_snapshot_then_closes(client: Any) -> None:
    """A client attaching late is immediately correct, and is not left hanging."""
    task = _completed_task(client)

    with client.websocket_connect(f"/api/tasks/{task['id']}/ws") as socket:
        first = socket.receive_json()

        assert first["seq"] == 1
        assert first["task"]["id"] == task["id"]
        assert first["task"]["status"] == TaskStatus.COMPLETED.value
        assert first["event"] is None
        assert isinstance(first["serverTime"], str)

        # Nothing can change after a terminal task, so the server closes instead of
        # leaving the frontend holding an idle socket.
        with pytest.raises(WebSocketDisconnect):
            socket.receive_json()


def test_websocket_on_an_unknown_task_reports_the_error(client: Any) -> None:
    with client.websocket_connect("/api/tasks/nope/ws") as socket:
        message = socket.receive_json()

        assert message["error"]["code"] == "task_not_found"


def test_websocket_streams_snapshots_while_the_task_runs(settings: Settings) -> None:
    """The live path: a snapshot opens the stream and each event carries a snapshot."""
    with TestClient(create_app(settings, orchestrator_factory=_slow_stub())) as client:
        task_id = _submit(client, "Watch me run").json()["id"]

        with client.websocket_connect(f"/api/tasks/{task_id}/ws") as socket:
            opening = socket.receive_json()
            assert opening["seq"] == 1
            assert opening["task"]["id"] == task_id
            # The frontend reads status from the snapshot, never from the event type.
            assert opening["event"] is None

            for expected_seq in (2, 3):
                message = socket.receive_json()
                assert message["seq"] == expected_seq
                assert message["event"]["task_id"] == task_id
                assert message["task"] is not None
                assert message["task"]["id"] == task_id

        # Still running: the socket was closed by this test, not by completion.
        assert client.get(f"/api/tasks/{task_id}").json()["status"] in {
            TaskStatus.QUEUED.value,
            TaskStatus.STARTING.value,
            TaskStatus.RUNNING.value,
        }


def _slow_stub(total_seconds: float = 6.0) -> Any:
    """A stub that stays non-terminal long enough to observe, then completes.

    It never waits on an object owned by the test thread: ``TestClient`` runs the
    app on a different event loop, so a cross-thread ``Event`` would not wake it
    reliably. Sleeping instead lets every frame queue in the subscriber and be
    delivered on connect, which is what makes the assertions deterministic.
    """
    from app.schemas.event import EventType

    async def factory(context: Any) -> None:
        await context.transition(TaskStatus.STARTING)
        await context.emit(EventType.AGENT_STARTED, "Starting the task.")
        await context.transition(TaskStatus.RUNNING)
        for _ in range(3):
            await asyncio.sleep(0.05)
            await context.emit(EventType.LOG, "Working.")
        await asyncio.sleep(total_seconds)
        await context.complete(STUB_REPORT, message="Task completed.")

    return factory


# ------------------------------------------------------------------ cancellation --


def test_cancelling_a_running_task_settles_it_as_cancelled(settings: Settings) -> None:
    """Cancellation is cooperative but must always reach a terminal status."""
    with TestClient(create_app(settings, orchestrator_factory=_cancellable_stub())) as client:
        task_id = _submit(client, "Cancel me").json()["id"]
        _wait_for_status(client, task_id, TaskStatus.RUNNING.value)

        response = client.post(f"/api/tasks/{task_id}/cancel")

        # 202: a request, not a promise. The final status arrives via the stream.
        assert response.status_code == 202
        settled = _wait_for_terminal(client, task_id)
        assert settled["status"] == TaskStatus.CANCELLED.value

        events = client.get(f"/api/tasks/{task_id}/events").json()
        assert any(event["type"] == "task_cancelled" for event in events)


def _cancellable_stub() -> Any:
    """A stub that polls the cancel token, so a cancel is observed promptly."""
    from app.schemas.event import EventType

    async def factory(context: Any) -> None:
        await context.transition(TaskStatus.STARTING)
        await context.emit(EventType.AGENT_STARTED, "Starting the task.")
        await context.transition(TaskStatus.RUNNING)
        for _ in range(600):
            # The cooperative checkpoint the real orchestrator uses between steps.
            context.check_cancelled()
            await asyncio.sleep(0.05)
        await context.complete(STUB_REPORT, message="Task completed.")

    return factory


def test_cancelling_a_finished_task_is_rejected_not_silently_accepted(client: Any) -> None:
    """Pretending a completed task was cancelled would hide the real outcome."""
    task = _completed_task(client)

    response = client.post(f"/api/tasks/{task['id']}/cancel")

    assert response.status_code == 409
    assert response.json()["error"]["code"]
    assert client.get(f"/api/tasks/{task['id']}").json()["status"] == TaskStatus.COMPLETED.value


def test_cancelling_an_unknown_task_is_404(client: Any) -> None:
    assert client.post("/api/tasks/nope/cancel").status_code == 404


def _wait_for_status(client: Any, task_id: str, status: str) -> dict[str, Any]:
    deadline = time.monotonic() + TERMINAL_TIMEOUT_SECONDS
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = client.get(f"/api/tasks/{task_id}").json()
        if last["status"] == status:
            return last
        time.sleep(0.02)
    pytest.fail(f"task {task_id} never reached {status}; last={last.get('status')!r}")
