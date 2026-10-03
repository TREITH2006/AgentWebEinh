"""``/api/tasks/{id}/events`` — the replayable event log.

The frontend's polling fallback reads this endpoint, so it must be a complete
record: every event ever published for the task, in order, including those emitted
while no WebSocket was attached.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import APIRouter, Query, Response

from ..schemas.event import EventDto
from ..utils.time import now_iso
from .deps import TaskManagerDep

logger = logging.getLogger("agentwebeinh.api.events")

router = APIRouter(prefix="/api/tasks", tags=["events"])


@router.get(
    "/{task_id}/events",
    summary="List a task's events",
    response_model=list[EventDto],
)
async def list_events(
    task_id: str,
    manager: TaskManagerDep,
    response: Response,
    limit: Annotated[int | None, Query(ge=1, le=1_000)] = None,
) -> Any:
    """All events for a task, oldest first.

    A bare JSON array is returned because that is what the frontend's
    ``normalizeEventList`` reads directly; it also tolerates an ``{events: [...]}``
    envelope, but emitting the simpler shape keeps the contract single-formed.
    """
    events = await manager.task_events(task_id, limit=limit)
    response.headers["X-Event-Count"] = str(len(events))
    return events


@router.get("/{task_id}/events/stream-state", summary="Event stream summary")
async def stream_state(task_id: str, manager: TaskManagerDep) -> dict[str, Any]:
    """Small diagnostic used by the UI's reconnect logic."""
    events = await manager.task_events(task_id, limit=1)
    latest = events[-1] if events else None
    return {
        "task_id": task_id,
        "latest_event_id": latest.id if latest else None,
        "latest_event_at": latest.at if latest else None,
        "server_time": now_iso(),
    }


__all__ = ["router"]
