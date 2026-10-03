"""Task status state machine.

Only the eight statuses in :class:`~app.schemas.task.TaskStatus` may ever reach
the database. That is not cosmetic: the frontend normalises an unrecognised
status to ``queued``, which renders as a spinner, so an invalid status looks like
a task that never finishes.

Terminal statuses have no outgoing transitions. Once a task is settled its row is
immutable from the state machine's point of view, which is what stops a late
worker from resurrecting a finished task.
"""

from __future__ import annotations

from ..schemas.task import TERMINAL_STATUSES, TaskStatus


class InvalidTransition(RuntimeError):
    """Raised when a status change is not permitted."""

    def __init__(self, current: TaskStatus, target: TaskStatus) -> None:
        super().__init__(f"cannot move a task from {current.value} to {target.value}")
        self.current = current
        self.target = target


#: ``awaiting_approval`` is reachable and escapable even though the approval
#: routes are deferred: the status and event type exist in the frontend contract,
#: so the transition table reserves them for the future approval workflow.
ALLOWED_TRANSITIONS: dict[TaskStatus, frozenset[TaskStatus]] = {
    TaskStatus.READY: frozenset({TaskStatus.QUEUED}),
    TaskStatus.QUEUED: frozenset(
        {TaskStatus.STARTING, TaskStatus.FAILED, TaskStatus.CANCELLED}
    ),
    TaskStatus.STARTING: frozenset(
        {
            TaskStatus.RUNNING,
            TaskStatus.AWAITING_APPROVAL,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
        }
    ),
    TaskStatus.RUNNING: frozenset(
        {
            TaskStatus.AWAITING_APPROVAL,
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
        }
    ),
    TaskStatus.AWAITING_APPROVAL: frozenset(
        {
            TaskStatus.RUNNING,
            TaskStatus.COMPLETED,
            TaskStatus.FAILED,
            TaskStatus.CANCELLED,
        }
    ),
    TaskStatus.COMPLETED: frozenset(),
    TaskStatus.FAILED: frozenset(),
    TaskStatus.CANCELLED: frozenset(),
}


def is_terminal(status: TaskStatus) -> bool:
    """True once the backend must stop pushing updates for a task."""
    return status in TERMINAL_STATUSES


def can_transition(current: TaskStatus, target: TaskStatus) -> bool:
    return target in ALLOWED_TRANSITIONS.get(current, frozenset())


def ensure_transition(current: TaskStatus, target: TaskStatus) -> None:
    """Raise :class:`InvalidTransition` unless the change is allowed.

    Re-applying the *same* status is tolerated: workers re-assert state
    defensively and a no-op assertion should not be an error.
    """
    if current == target:
        return
    if not can_transition(current, target):
        raise InvalidTransition(current, target)


__all__ = [
    "ALLOWED_TRANSITIONS",
    "InvalidTransition",
    "can_transition",
    "ensure_transition",
    "is_terminal",
]
