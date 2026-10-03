"""Cooperative cancellation.

A cancel request never kills a task from the outside. It flips a per-task token,
and the orchestrator checks that token at every step boundary and inside every
await that could block. That is what makes cancellation safe: the browser context
is closed, the report is persisted and a ``task_cancelled`` event is emitted
before the task settles.

An uncancellable thread (a synchronous Playwright call) is bounded instead by the
configured per-step timeout, so a wedged browser cannot hold a worker forever.
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger("agentwebeinh.cancellation")


class TaskCancelled(Exception):
    """Raised inside a run when its cancellation token has been tripped."""

    def __init__(self, reason: str = "Cancellation requested.") -> None:
        super().__init__(reason)
        self.reason = reason


class CancellationToken:
    """A one-way flag a run can poll."""

    __slots__ = ("_event", "_reason", "task_id")

    def __init__(self, task_id: str) -> None:
        self.task_id = task_id
        self._event = asyncio.Event()
        self._reason: str | None = None

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    @property
    def reason(self) -> str | None:
        return self._reason

    def cancel(self, reason: str = "Cancellation requested.") -> None:
        if self._event.is_set():
            return
        self._reason = reason
        self._event.set()
        logger.info("task_cancellation_requested task_id=%s", self.task_id)

    def raise_if_cancelled(self) -> None:
        """Trip point for the run loop."""
        if self._event.is_set():
            raise TaskCancelled(self._reason or "Cancellation requested.")

    async def wait(self) -> str:
        return await self._event.wait()


class CancellationRegistry:
    """Tokens for the tasks currently known to be in flight."""

    def __init__(self) -> None:
        self._tokens: dict[str, CancellationToken] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, task_id: str) -> CancellationToken:
        async with self._lock:
            token = self._tokens.get(task_id)
            if token is None:
                token = CancellationToken(task_id)
                self._tokens[task_id] = token
            return token

    async def request(self, task_id: str, reason: str = "Cancellation requested.") -> bool:
        """Trip a task's token. Returns ``False`` when the task is not in flight."""
        async with self._lock:
            token = self._tokens.get(task_id)
        if token is None:
            return False
        token.cancel(reason)
        return True

    def is_cancelled(self, task_id: str) -> bool:
        token = self._tokens.get(task_id)
        return bool(token and token.cancelled)

    async def release(self, task_id: str) -> None:
        async with self._lock:
            self._tokens.pop(task_id, None)

    async def active_task_ids(self) -> list[str]:
        async with self._lock:
            return sorted(self._tokens)

    async def cancel_all(self, reason: str = "Backend shutting down.") -> int:
        """Trip every token so in-flight runs can unwind during shutdown."""
        async with self._lock:
            tokens = list(self._tokens.values())
        for token in tokens:
            token.cancel(reason)
        return len(tokens)


__all__ = ["CancellationRegistry", "CancellationToken", "TaskCancelled"]
