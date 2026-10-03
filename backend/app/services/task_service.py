"""Task read/mapping use cases.

Also home to the row → DTO mapping, which is the single place where database
representation becomes wire representation. Keeping it here means the WebSocket
snapshot, ``GET /api/tasks/{id}`` and the statistics payload can never drift apart.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..config import Settings
from ..database.database import Database
from ..database.models import TaskRow
from ..database.repositories import EventRepository, TaskRepository
from ..schemas.event import EventDto, EventType
from ..schemas.report import TaskReportDto
from ..schemas.task import TaskDto, TaskErrorDto, TaskListResponse, TaskSort, TaskStatus

logger = logging.getLogger("agentwebeinh.task_service")


def _safe_status(value: str) -> TaskStatus:
    """Never raise on an unexpected stored status.

    Falls back to ``queued``, which is what the frontend itself does for an
    unrecognised value. Logging keeps the corruption visible.
    """
    try:
        return TaskStatus(value)
    except ValueError:
        logger.error("unknown_stored_status value=%r; treating as queued", value)
        return TaskStatus.QUEUED


def _decode_report(value: str | None) -> TaskReportDto | None:
    if not value:
        return None
    try:
        return TaskReportDto.model_validate(json.loads(value))
    except (json.JSONDecodeError, ValueError) as exc:
        logger.error("stored_report_unreadable error=%s", type(exc).__name__)
        return None


def to_task_dto(row: TaskRow) -> TaskDto:
    """Map a task row onto the wire contract."""
    error: TaskErrorDto | None = None
    if row.error_message:
        error = TaskErrorDto(
            message=row.error_message,
            code=row.error_code,
            retryable=row.error_retryable,
        )

    return TaskDto(
        id=row.id,
        prompt=row.prompt,
        # Left as stored (usually None) so the frontend applies its own
        # derivation; two truncation rules would inevitably disagree.
        title=row.title,
        status=_safe_status(row.status),
        created_at=row.created_at,
        started_at=row.started_at,
        completed_at=row.completed_at,
        duration_ms=row.duration_ms,
        progress=row.progress,
        current_activity=row.current_activity,
        current_url=row.current_url,
        current_title=row.current_title,
        error=error,
        report=_decode_report(row.report_json),
    )


def to_event_dto(row: Any) -> EventDto:
    """Map an event row onto the wire contract."""
    data: dict[str, Any] | None = None
    if row.data_json:
        try:
            parsed = json.loads(row.data_json)
            data = parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:  # pragma: no cover - defensive
            data = None
    return EventDto(
        id=row.id,
        task_id=row.task_id,
        type=EventType(row.type),
        message=row.message,
        at=row.at,
        detail=row.detail,
        url=row.url,
        data=data,
    )


class TaskService:
    """Read-only task queries used by the transport layer."""

    def __init__(
        self,
        database: Database,
        settings: Settings,
        tasks: TaskRepository,
        events: EventRepository,
    ) -> None:
        self._database = database
        self._settings = settings
        self._tasks = tasks
        self._events = events

    async def get_task(self, task_id: str) -> TaskDto | None:
        async with self._database.session() as session:
            row = await self._tasks.get(session, task_id)
        return to_task_dto(row) if row is not None else None

    async def get_row(self, task_id: str) -> TaskRow | None:
        async with self._database.session() as session:
            return await self._tasks.get(session, task_id)

    async def list_tasks(
        self,
        *,
        search: str | None = None,
        status: str | None = None,
        sort: TaskSort = "newest",
        limit: int | None = None,
        offset: int = 0,
    ) -> TaskListResponse:
        capped = self._clamp_limit(limit)
        async with self._database.session() as session:
            rows, total = await self._tasks.list(
                session,
                search=search,
                status=status,
                sort=sort,
                limit=capped,
                offset=max(0, offset),
            )
        return TaskListResponse(
            items=[to_task_dto(row) for row in rows],
            total=total,
            limit=capped,
            offset=max(0, offset),
        )

    async def recent_tasks(self, limit: int = 5) -> list[TaskDto]:
        async with self._database.session() as session:
            rows = await self._tasks.recent(session, min(limit, 50))
        return [to_task_dto(row) for row in rows]

    async def events_for_task(
        self, task_id: str, *, limit: int | None = None
    ) -> list[EventDto]:
        async with self._database.session() as session:
            rows = await self._events.list_for_task(session, task_id, limit=limit)
        return [to_event_dto(row) for row in rows]

    def _clamp_limit(self, limit: int | None) -> int:
        if limit is None or limit <= 0:
            return self._settings.history_default_limit
        return min(limit, self._settings.history_max_limit)


__all__ = ["TaskService", "to_event_dto", "to_task_dto"]
