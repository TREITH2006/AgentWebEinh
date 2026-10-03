"""``/api/tasks/{id}/ws`` — the live task stream.

Contract details that the frontend depends on:

* Frames are ``{"seq": <int>, "serverTime": <iso>, "event"?: ..., "task"?: ...}``.
  The frontend keys off *presence*, not the ``type`` discriminator, so both shapes
  are legitimate: an event frame always carries ``task``, the opening frame carries
  only a snapshot.
* ``seq`` starts at 1 for each connection and increments by one. The frontend resets
  its counter on connect and re-reads the task if it sees a hole.
* Reconnecting always replays the current snapshot, so a client that reconnects
  mid-run is immediately correct without replaying history.
* The socket closes with code 1000 once the task is terminal. A task that finished
  before the client connected is reported and closed immediately, rather than left
  open doing nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..core.event_manager import EventManager, Subscriber
from ..core.state_machine import is_terminal
from ..services.task_service import TaskService
from ..utils.time import now_iso

logger = logging.getLogger("agentwebeinh.api.websocket")

router = APIRouter(prefix="/api/tasks", tags=["stream"])

#: Normal closure, used once a terminal task has been reported.
CLOSE_NORMAL = 1000
#: Close when the referenced task does not exist.
CLOSE_UNKNOWN_TASK = 4404
#: Heartbeat cadence, well under typical proxy idle timeouts.
HEARTBEAT_SECONDS = 20.0


@router.websocket("/{task_id}/ws")
async def task_stream(
    websocket: WebSocket,
    task_id: str,
) -> None:
    """Stream task events and snapshots for the lifetime of the task."""
    events: EventManager = websocket.app.state.event_manager
    tasks: TaskService = websocket.app.state.task_service

    await websocket.accept()

    snapshot = await tasks.get_task(task_id)
    if snapshot is None:
        await websocket.send_json(
            {"seq": 1, "serverTime": now_iso(), "error": {"code": "task_not_found",
             "message": f"No task with id {task_id!r}."}}
        )
        await websocket.close(code=CLOSE_UNKNOWN_TASK)
        return

    subscriber = await events.subscribe(task_id)
    try:
        # The opening snapshot consumes seq 1 so numbering is contiguous from the
        # first frame the client ever sees.
        opening = await events.snapshot_message(subscriber, snapshot)
        if opening is not None:
            await websocket.send_json(opening)

        if is_terminal(snapshot.status):
            logger.info("ws_terminal_immediately task_id=%s status=%s", task_id, snapshot.status.value)
            await websocket.close(code=CLOSE_NORMAL)
            return

        await _pump(websocket, events, subscriber)
    except WebSocketDisconnect:
        logger.debug("ws_client_disconnected task_id=%s", task_id)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        logger.exception("ws_error task_id=%s error=%s", task_id, type(exc).__name__)
        with contextlib.suppress(Exception):
            await websocket.close(code=1011)
    finally:
        await events.unsubscribe(subscriber)


async def _pump(websocket: WebSocket, events: EventManager, subscriber: Subscriber) -> None:
    """Forward queued frames, and heartbeat while a task produces no events.

    The heartbeat exists because a long model call can leave the socket silent for
    minutes. Without it a proxy would close an idle connection and the frontend
    would fall back to polling for no good reason. Heartbeats carry no ``event``
    field, so the frontend ignores them for state purposes while keeping the
    connection measured.

    A heartbeat is still a frame on this connection, so it consumes its own ``seq``.
    Reusing the previous number would hand the client two frames with the same
    sequence and break the "contiguous from 1" invariant the frontend relies on to
    detect dropped frames.
    """
    queue = subscriber.queue
    while True:
        try:
            message = await asyncio.wait_for(queue.get(), timeout=HEARTBEAT_SECONDS)
        except TimeoutError:
            await websocket.send_json({"seq": subscriber.next_seq(), "serverTime": now_iso()})
            continue

        await websocket.send_json(message)

        # Close once a terminal frame has been delivered, so a client is not left
        # holding an open socket for a task that can never change again.
        task_snapshot = message.get("task") or {}
        status_value = task_snapshot.get("status")
        event_type = (message.get("event") or {}).get("type")
        if status_value in ("completed", "failed", "cancelled") or event_type in (
            "task_completed",
            "task_failed",
            "task_cancelled",
        ):
            await websocket.close(code=CLOSE_NORMAL)
            return


__all__ = ["CLOSE_NORMAL", "CLOSE_UNKNOWN_TASK", "HEARTBEAT_SECONDS", "router"]
