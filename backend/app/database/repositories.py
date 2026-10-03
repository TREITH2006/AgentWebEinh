"""Data access. No business rules live here.

Every method takes an :class:`~sqlalchemy.ext.asyncio.AsyncSession` so the caller
controls the transaction boundary, and nothing in this module knows about HTTP
or about the task state machine.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from typing import Any

from sqlalchemy import Select, and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from ..schemas.task import TaskSort, TaskStatus
from ..utils.ids import new_event_id, new_task_id
from ..utils.time import now_iso
from .models import EventRow, TaskRow

logger = logging.getLogger("agentwebeinh.repositories")

#: Retry budget for appending an event when two writers race on ``seq``.
_SEQ_RETRIES = 3


def _escape_like(value: str) -> str:
    """Escape LIKE wildcards so a search for ``100%`` is a literal search."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _dumps(value: Any) -> str | None:
    if value is None:
        return None
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):  # pragma: no cover - defensive
        logger.warning("payload_not_json_serialisable type=%s", type(value).__name__)
        return json.dumps(str(value), ensure_ascii=False)


def _loads(value: str | None) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:  # pragma: no cover - defensive
        logger.warning("stored_json_unreadable")
        return None


class TaskRepository:
    """Reads and writes on the ``tasks`` table."""

    async def create(
        self,
        session: AsyncSession,
        *,
        prompt: str,
        title: str | None = None,
        client_request_id: str | None = None,
    ) -> tuple[TaskRow, bool]:
        """Insert a queued task, or return the existing one for a repeated key.

        Returns ``(row, created)``. ``created`` is ``False`` when
        ``client_request_id`` had already been used, which is how a retried
        submit avoids starting a second run of the same instruction.
        """
        if client_request_id:
            existing = await self.by_client_request_id(session, client_request_id)
            if existing is not None:
                logger.info("task_submit_deduplicated client_request_id=%s", client_request_id)
                return existing, False

        row = TaskRow(
            id=new_task_id(),
            prompt=prompt,
            title=title,
            status=TaskStatus.QUEUED.value,
            created_at=now_iso(),
            client_request_id=client_request_id,
            frames_captured=0,
        )
        session.add(row)
        try:
            await session.flush()
        except IntegrityError:
            # Lost a race against a concurrent identical request.
            await session.rollback()
            if client_request_id:
                existing = await self.by_client_request_id(session, client_request_id)
                if existing is not None:
                    return existing, False
            raise
        return row, True

    async def get(self, session: AsyncSession, task_id: str) -> TaskRow | None:
        return await session.get(TaskRow, task_id)

    async def by_client_request_id(
        self, session: AsyncSession, client_request_id: str
    ) -> TaskRow | None:
        result = await session.execute(
            select(TaskRow).where(TaskRow.client_request_id == client_request_id)
        )
        return result.scalar_one_or_none()

    async def by_status(
        self, session: AsyncSession, statuses: Sequence[str]
    ) -> list[TaskRow]:
        """All tasks in any of ``statuses``; used by startup recovery."""
        if not statuses:
            return []
        result = await session.execute(
            select(TaskRow).where(TaskRow.status.in_(list(statuses)))
        )
        return list(result.scalars().all())

    # ------------------------------------------------------------------ list --

    def _filtered(
        self,
        search: str | None,
        status: str | None,
    ) -> Select[Any]:
        query = select(TaskRow)
        if status:
            query = query.where(TaskRow.status == status)
        if search and search.strip():
            pattern = f"%{_escape_like(search.strip())}%"
            query = query.where(
                or_(
                    TaskRow.prompt.like(pattern, escape="\\"),
                    TaskRow.title.like(pattern, escape="\\"),
                    TaskRow.id.like(pattern, escape="\\"),
                )
            )
        return query

    @staticmethod
    def _sorted(query: Select[Any], sort: TaskSort) -> Select[Any]:
        # ``duration_ms IS NULL`` first keeps unfinished tasks out of the
        # duration rankings in both directions.
        if sort == "oldest":
            return query.order_by(TaskRow.created_at.asc(), TaskRow.id.asc())
        if sort == "longest":
            return query.order_by(
                (TaskRow.duration_ms.is_(None)).asc(),
                TaskRow.duration_ms.desc(),
                TaskRow.id.desc(),
            )
        if sort == "shortest":
            return query.order_by(
                (TaskRow.duration_ms.is_(None)).asc(),
                TaskRow.duration_ms.asc(),
                TaskRow.id.desc(),
            )
        return query.order_by(TaskRow.created_at.desc(), TaskRow.id.desc())

    async def list(
        self,
        session: AsyncSession,
        *,
        search: str | None,
        status: str | None,
        sort: TaskSort,
        limit: int,
        offset: int,
    ) -> tuple[list[TaskRow], int]:
        """Return a page of tasks plus the unpaged total for the same filters."""
        rows_result = await session.execute(
            self._sorted(self._filtered(search, status), sort).limit(limit).offset(offset)
        )
        rows = list(rows_result.scalars().all())

        count_result = await session.execute(
            select(func.count()).select_from(self._filtered(search, status).subquery())
        )
        total = int(count_result.scalar_one())
        return rows, total

    async def recent(self, session: AsyncSession, limit: int) -> list[TaskRow]:
        result = await session.execute(
            select(TaskRow).order_by(TaskRow.created_at.desc(), TaskRow.id.desc()).limit(limit)
        )
        return list(result.scalars().all())

    # --------------------------------------------------------------- updates --

    async def update(
        self, session: AsyncSession, task_id: str, **fields: Any
    ) -> TaskRow | None:
        """Patch mutable columns.

        ``None`` is ignored rather than written as NULL, so a caller that patches
        one field cannot accidentally blank out the others. Clearing a column is
        therefore explicit: go through :meth:`settle` or write the attribute on the
        row directly.
        """
        row = await self.get(session, task_id)
        if row is None:
            return None
        for key, value in fields.items():
            if value is not None and hasattr(row, key):
                setattr(row, key, value)
        await session.flush()
        return row

    async def settle(
        self,
        session: AsyncSession,
        task_id: str,
        *,
        status: TaskStatus,
        completed_at: str | None = None,
        duration_ms: int | None = None,
        error: dict[str, Any] | None = None,
        report: dict[str, Any] | None = None,
    ) -> TaskRow | None:
        """Write the terminal state, the report and the error in one transaction.

        Atomicity matters: the frontend re-reads the task as soon as it observes
        a terminal snapshot, so the report must be visible in the same commit
        that moves the task out of an active status.
        """
        row = await self.get(session, task_id)
        if row is None:
            return None
        row.status = status.value
        row.completed_at = completed_at or now_iso()
        if duration_ms is not None:
            row.duration_ms = duration_ms
        row.progress = 1.0 if status is TaskStatus.COMPLETED else None
        if error:
            row.error_code = error.get("code")
            row.error_message = error.get("message")
            row.error_retryable = error.get("retryable")
        if report is not None:
            row.report_json = _dumps(report)
        await session.flush()
        return row

    async def record_frame(self, session: AsyncSession, task_id: str, at: str) -> None:
        """Bump the frame counters; called on a throttled cadence, not per frame."""
        row = await self.get(session, task_id)
        if row is None:
            return
        row.frames_captured = (row.frames_captured or 0) + 1
        row.last_frame_at = at
        await session.flush()

    # ------------------------------------------------------------ statistics --

    async def counts_by_status(
        self, session: AsyncSession, *, start: str, end: str
    ) -> dict[str, int]:
        """Outcome counts for tasks that *settled* inside ``[start, end)``.

        Outcomes are attributed to the day a task finished, because that is what
        a user means by "how many failed on Tuesday".
        """
        result = await session.execute(
            select(TaskRow.status, func.count())
            .where(
                and_(
                    TaskRow.completed_at.is_not(None),
                    TaskRow.completed_at >= start,
                    TaskRow.completed_at < end,
                )
            )
            .group_by(TaskRow.status)
        )
        counts = dict.fromkeys(_STATUS_KEYS, 0)
        for status, count in result.all():
            counts[status] = int(count)
        return counts

    async def performed_per_day(
        self, session: AsyncSession, *, start: str, end: str
    ) -> dict[str, int]:
        """Tasks *created* per UTC day. Fixed-width ISO makes ``substr`` exact."""
        result = await session.execute(
            select(func.substr(TaskRow.created_at, 1, 10), func.count())
            .where(and_(TaskRow.created_at >= start, TaskRow.created_at < end))
            .group_by(func.substr(TaskRow.created_at, 1, 10))
        )
        return {str(day): int(count) for day, count in result.all()}

    async def outcomes_per_day(
        self, session: AsyncSession, *, start: str, end: str
    ) -> dict[str, dict[str, float]]:
        """Per-day outcome counts and average duration for settled tasks."""
        result = await session.execute(
            select(
                func.substr(TaskRow.completed_at, 1, 10).label("day"),
                func.sum(
                    func.iif(TaskRow.status == TaskStatus.COMPLETED.value, 1, 0)
                ),
                func.sum(func.iif(TaskRow.status == TaskStatus.FAILED.value, 1, 0)),
                func.sum(
                    func.iif(TaskRow.status == TaskStatus.CANCELLED.value, 1, 0)
                ),
                func.avg(TaskRow.duration_ms),
            )
            .where(
                and_(
                    TaskRow.completed_at.is_not(None),
                    TaskRow.completed_at >= start,
                    TaskRow.completed_at < end,
                )
            )
            .group_by(func.substr(TaskRow.completed_at, 1, 10))
        )
        days: dict[str, dict[str, float]] = {}
        for day, completed, failed, cancelled, avg_duration in result.all():
            days[str(day)] = {
                "completed": int(completed or 0),
                "failed": int(failed or 0),
                "cancelled": int(cancelled or 0),
                "avg_duration_ms": float(avg_duration) if avg_duration is not None else None,
            }
        return days

    async def average_duration_ms(
        self, session: AsyncSession, *, start: str, end: str
    ) -> int | None:
        result = await session.execute(
            select(func.avg(TaskRow.duration_ms)).where(
                and_(
                    TaskRow.completed_at.is_not(None),
                    TaskRow.duration_ms.is_not(None),
                    TaskRow.completed_at >= start,
                    TaskRow.completed_at < end,
                )
            )
        )
        average = result.scalar_one_or_none()
        return int(average) if average is not None else None

    async def count_created(self, session: AsyncSession, *, start: str, end: str) -> int:
        result = await session.execute(
            select(func.count()).select_from(TaskRow).where(
                and_(TaskRow.created_at >= start, TaskRow.created_at < end)
            )
        )
        return int(result.scalar_one())

    async def lifetime_counts(self, session: AsyncSession) -> dict[str, int]:
        """Status counts across all history, not just the requested range.

        The headline counters on ``GET /api/stats`` describe everything that has
        ever run; ``buckets`` describe the selected range.
        """
        result = await session.execute(
            select(TaskRow.status, func.count()).group_by(TaskRow.status)
        )
        counts = dict.fromkeys(_STATUS_KEYS, 0)
        for status, count in result.all():
            counts[str(status)] = int(count)
        return counts

    async def lifetime_average_duration_ms(self, session: AsyncSession) -> int | None:
        """Average duration of every task that recorded one."""
        result = await session.execute(
            select(func.avg(TaskRow.duration_ms)).where(TaskRow.duration_ms.is_not(None))
        )
        average = result.scalar_one_or_none()
        return int(average) if average is not None else None


_STATUS_KEYS = (
    TaskStatus.QUEUED.value,
    TaskStatus.STARTING.value,
    TaskStatus.RUNNING.value,
    TaskStatus.AWAITING_APPROVAL.value,
    TaskStatus.COMPLETED.value,
    TaskStatus.FAILED.value,
    TaskStatus.CANCELLED.value,
)


class EventRepository:
    """Append-only access to the ``task_events`` table."""

    async def append(
        self,
        session: AsyncSession,
        *,
        task_id: str,
        event_type: str,
        message: str,
        detail: str | None = None,
        url: str | None = None,
        data: dict[str, Any] | None = None,
        at: str | None = None,
    ) -> EventRow:
        """Append one event with the next per-task ``seq``.

        ``seq`` is derived inside the transaction and protected by a unique
        constraint, so two writers cannot produce the same number. On a lost race
        the transaction is retried with a fresh ``seq``.
        """
        last = await self._last_row(session, task_id)
        seq = (last.seq + 1) if last is not None else 1

        for attempt in range(_SEQ_RETRIES):
            row = EventRow(
                id=new_event_id(),
                task_id=task_id,
                seq=seq,
                type=event_type,
                message=message,
                at=at or now_iso(),
                detail=detail,
                url=url,
                data_json=_dumps(data),
            )
            session.add(row)
            try:
                await session.flush()
                return row
            except IntegrityError:
                await session.rollback()
                if attempt == _SEQ_RETRIES - 1:
                    raise
                logger.debug("event_seq_race task_id=%s retry=%s", task_id, attempt + 1)
                last = await self._last_row(session, task_id)
                seq = (last.seq + 1) if last is not None else 1
        raise RuntimeError("unreachable")  # pragma: no cover

    async def _last_row(self, session: AsyncSession, task_id: str) -> EventRow | None:
        result = await session.execute(
            select(EventRow).where(EventRow.task_id == task_id).order_by(EventRow.seq.desc()).limit(1)
        )
        return result.scalar_one_or_none()

    async def list_for_task(
        self, session: AsyncSession, task_id: str, *, limit: int | None = None
    ) -> list[EventRow]:
        query = select(EventRow).where(EventRow.task_id == task_id).order_by(EventRow.seq.asc())
        if limit is not None:
            query = query.limit(limit)
        result = await session.execute(query)
        return list(result.scalars().all())

    async def count_for_task(self, session: AsyncSession, task_id: str) -> int:
        result = await session.execute(
            select(func.count()).select_from(EventRow).where(EventRow.task_id == task_id)
        )
        return int(result.scalar_one())


def row_to_report(row: TaskRow) -> dict[str, Any] | None:
    """Decoded report payload for a task row, or ``None``."""
    return _loads(row.report_json)


__all__ = ["EventRepository", "TaskRepository", "row_to_report"]
