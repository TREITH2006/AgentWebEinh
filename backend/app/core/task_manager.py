"""Task lifecycle: submission, queueing, workers, cancellation and recovery.

Ordering guarantee
------------------
:class:`TaskContext.settle` writes the terminal status **and** the report in one
committed transaction, and only then publishes the terminal event. The frontend
re-reads ``GET /api/tasks/{id}`` the instant it sees a terminal snapshot, so
publishing first would race the report write and the UI would render "no report
returned" for a task that had one.

Run-time dependency direction
-----------------------------
``TaskManager`` receives an ``orchestrator_factory`` callable instead of importing
:class:`~app.core.orchestrator.Orchestrator`, which keeps the dependency one-way:
the orchestrator may use :class:`TaskContext`, never the manager.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from ..config import Settings
from ..database.database import Database
from ..database.repositories import EventRepository, TaskRepository
from ..errors import ApiError, invalid_prompt, invalid_state, service_unavailable, task_not_found
from ..schemas.event import EventDto, EventType
from ..schemas.task import TaskDto, TaskSort, TaskStatus
from ..services.task_service import TaskService, to_task_dto
from ..utils.time import elapsed_ms, now_iso
from .cancellation import CancellationRegistry, CancellationToken, TaskCancelled
from .event_manager import EventManager
from .state_machine import InvalidTransition, ensure_transition, is_terminal

logger = logging.getLogger("agentwebeinh.task_manager")

#: Builds and runs one task. Injected to avoid a circular import.
OrchestratorFactory = Callable[["TaskContext"], Awaitable[None]]

#: Statuses that cannot survive a backend restart: nothing is left to drive them.
#: ``queued`` is deliberately excluded — it carries no in-flight work, so
#: :meth:`TaskManager.enqueue_pending` resumes it instead of failing it.
_INTERRUPTED_STATUSES = (
    TaskStatus.STARTING.value,
    TaskStatus.RUNNING.value,
    TaskStatus.AWAITING_APPROVAL.value,
)

_TERMINAL_EVENTS: dict[TaskStatus, EventType] = {
    TaskStatus.COMPLETED: EventType.TASK_COMPLETED,
    TaskStatus.FAILED: EventType.TASK_FAILED,
    TaskStatus.CANCELLED: EventType.TASK_CANCELLED,
}

_TERMINAL_MESSAGES: dict[TaskStatus, str] = {
    TaskStatus.COMPLETED: "Task completed.",
    TaskStatus.FAILED: "Task failed.",
    TaskStatus.CANCELLED: "Task cancelled.",
}


class TaskContext:
    """Everything one run is allowed to do to its own task.

    Handed to the orchestrator. It exposes intent (``update``, ``transition``,
    ``emit``, ``settle``) and nothing else, so the orchestrator cannot bypass the
    state machine or write a terminal state without a report decision.
    """

    def __init__(
        self,
        *,
        task_id: str,
        prompt: str,
        settings: Settings,
        database: Database,
        tasks: TaskRepository,
        events: EventManager,
        cancel: CancellationToken,
    ) -> None:
        self.task_id = task_id
        self.prompt = prompt
        self.settings = settings
        self.cancel = cancel
        self._database = database
        self._tasks = tasks
        self._events = events

    # ------------------------------------------------------------- inspection --

    @property
    def cancelled(self) -> bool:
        return self.cancel.cancelled

    def check_cancelled(self) -> None:
        """Cooperative trip point; call before and after every slow step."""
        self.cancel.raise_if_cancelled()

    async def current_status(self) -> TaskStatus | None:
        async with self._database.session() as session:
            row = await self._tasks.get(session, self.task_id)
        return TaskStatus(row.status) if row else None

    async def snapshot(self) -> TaskDto | None:
        async with self._database.session() as session:
            row = await self._tasks.get(session, self.task_id)
        return to_task_dto(row) if row else None

    # ----------------------------------------------------------------- writes --

    async def update(self, **fields: Any) -> None:
        """Patch mutable task columns (activity, url, progress, ...)."""
        allowed = {
            "current_activity",
            "current_url",
            "current_title",
            "progress",
            "started_at",
            "engine",
        }
        payload = {key: value for key, value in fields.items() if key in allowed}
        if not payload:
            return
        async with self._database.session() as session:
            await self._tasks.update(session, self.task_id, **payload)

    async def transition(self, target: TaskStatus) -> None:
        """Validate and persist a status change.

        Entering ``starting`` stamps ``started_at`` exactly once, so a task that
        never reaches a terminal state still reports how long it ran.

        No event is published here: the caller emits the matching lifecycle event
        immediately afterwards, and that event carries the new snapshot.
        """
        current = await self.current_status()
        if current is None:
            raise service_unavailable("The task no longer exists.")
        ensure_transition(current, target)
        async with self._database.session() as session:
            fields: dict[str, Any] = {"status": target.value}
            if target is TaskStatus.STARTING:
                row = await self._tasks.get(session, self.task_id)
                if row is not None and not row.started_at:
                    fields["started_at"] = now_iso()
            await self._tasks.update(session, self.task_id, **fields)

    async def emit(
        self,
        event_type: EventType,
        message: str,
        *,
        detail: str | None = None,
        url: str | None = None,
        data: dict[str, Any] | None = None,
    ) -> EventDto | None:
        """Publish an event. The attached snapshot reflects prior :meth:`update`s.

        Cancellation is deliberately *not* checked here: a run that trips while
        emitting its own ``task_cancelled`` event must still be able to publish it.
        Runs check the token at step boundaries instead.
        """
        return await self._events.publish(
            self.task_id, event_type, message, detail=detail, url=url, data=data
        )

    async def note_frame(self, url: str | None, title: str | None, byte_size: int) -> None:
        """Record that a frame was captured (throttled by the caller)."""
        async with self._database.session() as session:
            await self._tasks.update(
                session,
                self.task_id,
                last_frame_at=now_iso(),
                current_url=url or None,
                current_title=title or None,
            )
        logger.debug(
            "frame_recorded task_id=%s bytes=%s url=%s", self.task_id, byte_size, url
        )

    async def count_frame(self) -> None:
        async with self._database.session() as session:
            await self._tasks.record_frame(session, self.task_id, now_iso())

    # -------------------------------------------------------------- terminal --

    async def settle(
        self,
        target: TaskStatus,
        *,
        error: dict[str, Any] | None = None,
        report: dict[str, Any] | None = None,
        message: str | None = None,
        detail: str | None = None,
    ) -> bool:
        """Commit the terminal state plus report, then publish the terminal event.

        Idempotent: a second call for an already-settled task is a no-op, which
        lets the worker use it as a safety net after an unexpected error.
        """
        current = await self.current_status()
        if current is None:
            logger.warning("settle_skipped_missing_task task_id=%s", self.task_id)
            return False
        if is_terminal(current):
            logger.info(
                "settle_ignored task_id=%s current=%s requested=%s",
                self.task_id,
                current.value,
                target.value,
            )
            return False

        with contextlib.suppress(InvalidTransition):
            ensure_transition(current, target)

        completed_at = now_iso()
        async with self._database.session() as session:
            row = await self._tasks.get(session, self.task_id)
            reference = (row.started_at or row.created_at) if row else None
            await self._tasks.settle(
                session,
                self.task_id,
                status=target,
                completed_at=completed_at,
                duration_ms=elapsed_ms(reference, completed_at),
                error=error,
                report=report,
            )
        # Committed: the snapshot attached to this event now carries the report.
        await self._events.publish(
            self.task_id,
            _TERMINAL_EVENTS[target],
            message or _TERMINAL_MESSAGES[target],
            detail=detail,
            data={"status": target.value} if error is None else {"status": target.value, **error},
        )
        logger.info("task_settled task_id=%s status=%s", self.task_id, target.value)
        return True

    async def fail(self, code: str, message: str, *, retryable: bool = False) -> bool:
        return await self.settle(
            TaskStatus.FAILED,
            error={"code": code, "message": message, "retryable": retryable},
            message="Task failed.",
            detail=message,
        )

    async def complete(self, report: dict[str, Any], *, message: str | None = None) -> bool:
        return await self.settle(TaskStatus.COMPLETED, report=report, message=message)


class TaskManager:
    """Owns the in-process queue and the worker pool."""

    def __init__(
        self,
        *,
        database: Database,
        settings: Settings,
        tasks: TaskRepository,
        events: EventRepository,
        event_manager: EventManager,
        orchestrator_factory: OrchestratorFactory,
        cancellation: CancellationRegistry | None = None,
    ) -> None:
        self._database = database
        self._settings = settings
        self._tasks = tasks
        self._events_repo = events
        self._event_manager = event_manager
        self._orchestrator_factory = orchestrator_factory
        self.cancellation = cancellation or CancellationRegistry()
        self._service = TaskService(database, settings, tasks, events)
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._workers: list[asyncio.Task[None]] = []
        self._running = False
        self._inflight: set[str] = set()

    # ------------------------------------------------------------- lifecycle --

    @property
    def ready(self) -> bool:
        return self._running and bool(self._workers)

    @property
    def inflight_count(self) -> int:
        return len(self._inflight)

    @property
    def queued_count(self) -> int:
        return self._queue.qsize()

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        for index in range(self._settings.max_concurrent_tasks):
            self._workers.append(
                asyncio.create_task(self._worker(index), name=f"awe-worker-{index}")
            )
        logger.info(
            "task_manager_started workers=%s", self._settings.max_concurrent_tasks
        )

    async def stop(self) -> None:
        if not self._running:
            return
        self._running = False
        tripped = await self.cancellation.cancel_all("Backend shutting down.")
        logger.info("task_manager_stopping cancel_requested=%s", tripped)
        for worker in self._workers:
            worker.cancel()
        for worker in self._workers:
            with contextlib.suppress(asyncio.CancelledError):
                await worker
        self._workers.clear()
        logger.info("task_manager_stopped")

    async def _worker(self, index: int) -> None:
        logger.debug("worker_ready index=%s", index)
        while True:
            task_id = await self._queue.get()
            try:
                await self._run_one(task_id)
            except asyncio.CancelledError:
                # Shutdown: put the id back so a restart can recover it.
                self._queue.put_nowait(task_id)
                raise
            except Exception:
                logger.exception("worker_error index=%s task_id=%s", index, task_id)
            finally:
                self._inflight.discard(task_id)
                self._queue.task_done()

    async def _run_one(self, task_id: str) -> None:
        self._inflight.add(task_id)
        context = await self._build_context(task_id)
        if context is None:
            logger.warning("run_skipped_missing_task task_id=%s", task_id)
            return

        try:
            await asyncio.wait_for(
                self._orchestrator_factory(context),
                timeout=self._settings.task_timeout_seconds,
            )
        except TaskCancelled:
            logger.info("run_cancelled task_id=%s", task_id)
            await context.settle(
                TaskStatus.CANCELLED,
                message="Task cancelled.",
                detail=context.cancel.reason,
            )
        except TimeoutError:
            logger.warning("run_timed_out task_id=%s", task_id)
            await context.fail(
                "task_timeout",
                f"The task exceeded the {self._settings.task_timeout_seconds}s time limit.",
                retryable=True,
            )
        except Exception as exc:
            logger.exception("run_failed task_id=%s", task_id)
            await context.fail(
                "internal_error",
                f"The run stopped unexpectedly ({type(exc).__name__}).",
                retryable=True,
            )
        finally:
            await self.cancellation.release(task_id)

    async def _build_context(self, task_id: str) -> TaskContext | None:
        async with self._database.session() as session:
            row = await self._tasks.get(session, task_id)
        if row is None:
            return None
        if is_terminal(TaskStatus(row.status)):
            logger.info("run_skipped_terminal task_id=%s status=%s", task_id, row.status)
            return None
        token = await self.cancellation.get_or_create(task_id)
        return TaskContext(
            task_id=task_id,
            prompt=row.prompt,
            settings=self._settings,
            database=self._database,
            tasks=self._tasks,
            events=self._event_manager,
            cancel=token,
        )

    # ------------------------------------------------------------ submission --

    async def submit(
        self, prompt: str, *, client_request_id: str | None = None
    ) -> tuple[TaskDto, bool]:
        """Create (or de-duplicate) a task and queue it. Returns ``(dto, created)``."""
        self._validate_prompt(prompt)

        async with self._database.session() as session:
            row, created = await self._tasks.create(
                session, prompt=prompt, client_request_id=client_request_id
            )
            task_id = row.id

        if not created:
            dto = await self._service.get_task(task_id)
            assert dto is not None
            return dto, False

        dto = await self._service.get_task(task_id)
        assert dto is not None
        await self._event_manager.publish(
            task_id,
            EventType.TASK_RECEIVED,
            "Task received and queued.",
            detail=prompt,
        )
        self._queue.put_nowait(task_id)
        logger.info("task_submitted task_id=%s queued=%s", task_id, self.queued_count)
        return dto, True

    def _validate_prompt(self, prompt: str) -> None:
        text = (prompt or "").strip()
        if len(text) < self._settings.prompt_min_length:
            raise invalid_prompt("Describe the task in a sentence or more.")
        if len(text) > self._settings.prompt_max_length:
            raise invalid_prompt(
                f"Keep the task under {self._settings.prompt_max_length} characters."
            )

    # --------------------------------------------------------------- queries --

    async def get_task(self, task_id: str) -> TaskDto:
        dto = await self._service.get_task(task_id)
        if dto is None:
            raise task_not_found(task_id)
        return dto

    async def list_tasks(
        self,
        *,
        search: str | None,
        status: str | None,
        sort: TaskSort,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        return await self._service.list_tasks(
            search=search, status=status, sort=sort, limit=limit, offset=offset
        )

    async def task_events(self, task_id: str, *, limit: int | None = None) -> list[EventDto]:
        await self.get_task(task_id)  # 404s consistently
        return await self._event_manager.history(task_id, limit=limit)

    # ---------------------------------------------------------- cancellation --

    async def cancel(self, task_id: str) -> TaskDto:
        """Request cooperative cancellation.

        Returns ``202`` semantics: the task settles through the normal event
        stream, so the response deliberately does not promise a final status.
        """
        dto = await self.get_task(task_id)
        if is_terminal(dto.status):
            raise invalid_state(
                f"The task already finished with status {dto.status.value}."
            )

        if await self.cancellation.request(task_id, "Cancelled by the user."):
            logger.info("task_cancel_requested task_id=%s", task_id)
            return dto

        # No live run: the only case worth settling here is a task still queued.
        if dto.status is TaskStatus.QUEUED:
            context = await self._build_context(task_id)
            if context is not None:
                await context.settle(
                    TaskStatus.CANCELLED,
                    message="Task cancelled.",
                    detail="Cancelled before execution started.",
                )
                refreshed = await self._service.get_task(task_id)
                return refreshed or dto

        raise ApiError(
            409,
            "not_running",
            "The task is not currently executing, so it cannot be cancelled.",
        )

    # --------------------------------------------------------------- recovery --

    async def recover_interrupted(self) -> int:
        """Fail tasks left active by a previous process.

        Without this a restart would leave rows in ``running`` forever, and the
        frontend would poll a task that nothing is driving any more.
        """
        interrupted = 0
        async with self._database.session() as session:
            rows = await self._tasks.by_status(session, _INTERRUPTED_STATUSES)
            for row in rows:
                context = TaskContext(
                    task_id=row.id,
                    prompt=row.prompt,
                    settings=self._settings,
                    database=self._database,
                    tasks=self._tasks,
                    events=self._event_manager,
                    cancel=await self.cancellation.get_or_create(row.id),
                )
                await context.fail(
                    "interrupted_by_restart",
                    "The backend restarted while this task was running, so it was "
                    "stopped. Submit it again to retry.",
                    retryable=True,
                )
                await self.cancellation.release(row.id)
                interrupted += 1
        if interrupted:
            logger.warning("tasks_recovered_after_restart count=%s", interrupted)
        return interrupted

    async def enqueue_pending(self) -> int:
        """Re-queue tasks that were still ``queued`` when the process stopped.

        A queued task has produced no work and holds no browser, model or adapter
        resources, so resuming it is both safe and strictly better than failing it.
        Anything further along was already failed by :meth:`recover_interrupted`.
        """
        pending: list[str] = []
        async with self._database.session() as session:
            rows = await self._tasks.by_status(session, (TaskStatus.QUEUED.value,))
            pending = [row.id for row in rows]
        for task_id in pending:
            self._queue.put_nowait(task_id)
        if pending:
            logger.info("tasks_requeued count=%s", len(pending))
        return len(pending)


__all__ = ["OrchestratorFactory", "TaskContext", "TaskManager"]
