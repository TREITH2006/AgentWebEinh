"""Event persistence and WebSocket fan-out.

This module owns the parts of the streaming contract that are easy to get subtly
wrong, so they are stated once here:

**Every published message carries a full task snapshot.** The frontend does not
derive status, activity, progress or location from the event type — it only reads
them from the ``task`` field. An event-only stream leaves the workspace showing a
stale status forever, so :meth:`EventManager.publish` always attaches a snapshot
taken after the caller's row update.

**``seq`` is per connection and contiguous from 1.** It is *not* the database
sequence: the frontend resets its counter on every connect and re-reads the task
whenever it notices a hole, so each subscriber numbers its own messages. Gaps are
therefore only ever produced by deliberate queue overflow.

**Events are persisted before they are published.** ``GET /api/tasks/{id}/events``
must be a complete replay of what happened, including events published while no
WebSocket was attached.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from ..config import Settings
from ..database.database import Database
from ..database.repositories import EventRepository
from ..schemas.event import EventDto, EventType, StreamMessage
from ..schemas.task import TaskDto
from ..utils.time import now_iso

logger = logging.getLogger("agentwebeinh.events")

#: Resolves the current snapshot for a task, or ``None`` if it no longer exists.
SnapshotProvider = Callable[[str], Awaitable[TaskDto | None]]


# ``eq=False`` keeps identity equality and, crucially, the inherited ``__hash__``.
# A plain dataclass would be unhashable (it defines ``__eq__``), and the subscriber
# registry is a ``set`` — so every WebSocket connect would raise ``TypeError``.
# Two connections are the same subscriber only when they are the same object.
@dataclass(eq=False)
class Subscriber:
    """One attached WebSocket connection."""

    task_id: str
    queue: asyncio.Queue[dict[str, Any]]
    #: Per-connection message counter; see the module docstring.
    seq: int = 0
    dropped: int = field(default=0)

    def next_seq(self) -> int:
        self.seq += 1
        return self.seq

    def offer(self, message: dict[str, Any]) -> None:
        """Enqueue without blocking; shed the oldest frame if the client stalls.

        Dropping the oldest frame leaves a hole in ``seq``, which the frontend
        detects and repairs with a single ``GET /api/tasks/{id}``. Dropping the
        newest instead would leave the workspace showing stale state.
        """
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            try:
                self.queue.get_nowait()
                self.dropped += 1
                self.queue.put_nowait(message)
            except (asyncio.QueueEmpty, asyncio.QueueFull):  # pragma: no cover - racy
                self.dropped += 1


class EventManager:
    """Appends events to the database and fans them out to subscribers."""

    def __init__(
        self,
        database: Database,
        settings: Settings,
        repository: EventRepository,
        snapshot_provider: SnapshotProvider,
    ) -> None:
        self._database = database
        self._settings = settings
        self._repository = repository
        self._snapshot_provider = snapshot_provider
        self._subscribers: dict[str, set[Subscriber]] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._registry_lock = asyncio.Lock()

    # ------------------------------------------------------------ lock per task --

    async def _task_lock(self, task_id: str) -> asyncio.Lock:
        """Serialise event appends per task so ``seq`` stays gap-free."""
        async with self._registry_lock:
            lock = self._locks.get(task_id)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[task_id] = lock
            return lock

    # -------------------------------------------------------------- publishing --

    async def publish(
        self,
        task_id: str,
        event_type: EventType,
        message: str,
        *,
        detail: str | None = None,
        url: str | None = None,
        data: dict[str, Any] | None = None,
        at: str | None = None,
    ) -> EventDto | None:
        """Persist one event and deliver it, with a snapshot, to every subscriber.

        Returns ``None`` only when the task has disappeared, which happens if the
        database was reset underneath a running task.
        """
        async with await self._task_lock(task_id):
            timestamp = at or now_iso()
            async with self._database.session() as session:
                row = await self._repository.append(
                    session,
                    task_id=task_id,
                    event_type=event_type.value,
                    message=message,
                    detail=detail,
                    url=url,
                    data=data,
                    at=timestamp,
                )
                event = EventDto(
                    id=row.id,
                    task_id=task_id,
                    type=event_type,
                    message=message,
                    at=row.at,
                    detail=row.detail,
                    url=row.url,
                    data=data,
                )

            snapshot = await self._safe_snapshot(task_id)
            await self._fan_out(event, snapshot)

        logger.info(
            "event_published task_id=%s type=%s subscribers=%s",
            task_id,
            event_type.value,
            self.subscriber_count(task_id),
        )
        return event

    async def publish_log(self, task_id: str, message: str, **kwargs: Any) -> EventDto | None:
        """Convenience wrapper for the generic ``log`` event type."""
        return await self.publish(task_id, EventType.LOG, message, **kwargs)

    async def _safe_snapshot(self, task_id: str) -> TaskDto | None:
        try:
            return await self._snapshot_provider(task_id)
        except Exception as exc:  # noqa: BLE001 - a snapshot failure must not drop the event
            logger.error("snapshot_failed task_id=%s error=%s", task_id, type(exc).__name__)
            return None

    async def _fan_out(self, event: EventDto, snapshot: TaskDto | None) -> None:
        async with self._registry_lock:
            targets = list(self._subscribers.get(event.task_id, ()))
        for subscriber in targets:
            message = StreamMessage(
                seq=subscriber.next_seq(),
                serverTime=event.at,
                event=event,
                task=snapshot,
            )
            subscriber.offer(message.as_wire())

    # ---------------------------------------------------------- subscriptions --

    async def subscribe(self, task_id: str) -> Subscriber:
        subscriber = Subscriber(
            task_id=task_id,
            queue=asyncio.Queue(maxsize=self._settings.stream_queue_size),
        )
        async with self._registry_lock:
            self._subscribers.setdefault(task_id, set()).add(subscriber)
        logger.info("ws_subscribed task_id=%s", task_id)
        return subscriber

    async def unsubscribe(self, subscriber: Subscriber) -> None:
        async with self._registry_lock:
            group = self._subscribers.get(subscriber.task_id)
            if group is not None:
                group.discard(subscriber)
                if not group:
                    self._subscribers.pop(subscriber.task_id, None)
        logger.info("ws_unsubscribed task_id=%s", subscriber.task_id)

    def subscriber_count(self, task_id: str) -> int:
        return len(self._subscribers.get(task_id, ()))

    def total_subscribers(self) -> int:
        return sum(len(group) for group in self._subscribers.values())

    async def snapshot_message(
        self, subscriber: Subscriber, snapshot: TaskDto | None
    ) -> dict[str, Any] | None:
        """Build the opening frame for a new connection.

        The frontend also polls once on connect, but sending a snapshot makes the
        first paint immediate. It consumes ``seq`` 1, keeping numbering
        contiguous from the very first frame.
        """
        if snapshot is None:
            return None
        # ``task``, not ``snapshot``: the frontend reads the opening frame's
        # ``task`` key to paint immediately after connecting.
        message = StreamMessage(
            seq=subscriber.next_seq(),
            serverTime=now_iso(),
            task=snapshot,
        )
        return message.as_wire()

    # ---------------------------------------------------------------- history --

    async def history(self, task_id: str, *, limit: int | None = None) -> list[EventDto]:
        """Replayable history for ``GET /api/tasks/{id}/events``."""
        async with self._database.session() as session:
            rows = await self._repository.list_for_task(session, task_id, limit=limit)
        return [
            EventDto(
                id=row.id,
                task_id=row.task_id,
                type=EventType(row.type),
                message=row.message,
                at=row.at,
                detail=row.detail,
                url=row.url,
                data=_decode(row.data_json),
            )
            for row in rows
        ]

    async def count(self, task_id: str) -> int:
        async with self._database.session() as session:
            return await self._repository.count_for_task(session, task_id)


def _decode(value: str | None) -> dict[str, Any] | None:
    if not value:
        return None
    import json  # local import: only needed on the read path

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:  # pragma: no cover - defensive
        return None
    return parsed if isinstance(parsed, dict) else None


__all__ = ["EventManager", "SnapshotProvider", "Subscriber"]
