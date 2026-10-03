"""Wire DTOs for task events and the live stream envelope.

The stream envelope is deliberately **camelCase** while the DTOs inside it are
snake_case. That is not an inconsistency: ``src/lib/api/events.ts`` reads exactly
``seq``, ``serverTime``, ``event``, ``task`` and ``snapshot`` off the parsed
payload and dispatches purely on which keys are present. The documented
``{"type": "event"}`` discriminator is never read by the frontend, so it is not
emitted; the presence of ``event``/``task`` is what selects the payload.

Ordering inside one message matters: the frontend applies ``snapshot``, then
``event``, then ``task``. Sending the freshest ``task`` alongside each event is
what keeps the UI's status, activity and progress in step, because the frontend
does **not** derive status from the event type.
"""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..utils.time import now_iso
from .task import TaskDto


class EventType(str, Enum):
    """The twelve event types the frontend can render.

    An unknown type is normalised to ``log`` by the frontend, so this list is a
    convenience rather than a hard boundary — but every real lifecycle step
    should use one of these.
    """

    TASK_RECEIVED = "task_received"
    AGENT_STARTED = "agent_started"
    BROWSER_OPENED = "browser_opened"
    PAGE_NAVIGATED = "page_navigated"
    ELEMENT_INSPECTED = "element_inspected"
    ACTION_PERFORMED = "action_performed"
    INFORMATION_COLLECTED = "information_collected"
    APPROVAL_REQUESTED = "approval_requested"
    TASK_COMPLETED = "task_completed"
    TASK_FAILED = "task_failed"
    TASK_CANCELLED = "task_cancelled"
    LOG = "log"


#: Status implied by a terminal event. Recorded for the state machine and for
#: documentation; the frontend does not consume it, which is exactly why every
#: published message also carries a full task snapshot.
TERMINAL_EVENT_TYPES: frozenset[EventType] = frozenset(
    {
        EventType.TASK_COMPLETED,
        EventType.TASK_FAILED,
        EventType.TASK_CANCELLED,
    }
)


class EventDto(BaseModel):
    """One entry in the activity feed and in ``GET /api/tasks/{id}/events``.

    ``id`` must be stable and unique: the frontend de-duplicates the feed by id,
    so a regenerated id would show duplicates after a reconnect and a reused id
    would hide an event entirely.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: str
    task_id: str
    type: EventType
    message: str
    at: str
    detail: str | None = None
    url: str | None = None
    data: dict[str, Any] | None = None


class StreamMessage(BaseModel):
    """One WebSocket frame.

    Exactly two shapes are legitimate and the frontend keys off *presence*, not
    the discriminator: an event frame carries both ``event`` and ``task``, and the
    opening frame carries ``task`` only. There is deliberately no second snapshot
    field: a frame carrying ``snapshot`` instead of ``task`` would leave the
    frontend's first paint empty, since it only ever reads ``task``.

    ``seq`` starts at 1 per connection and is contiguous. The frontend compares
    it against the previous frame and, on a gap, silently re-reads
    ``GET /api/tasks/{id}`` to resynchronise.
    """

    seq: int
    serverTime: str = Field(default_factory=now_iso)  # noqa: N815 - wire name
    event: EventDto | None = None
    task: TaskDto | None = None

    def as_wire(self) -> dict[str, Any]:
        """Serialise with the exact keys ``events.ts`` reads."""
        return self.model_dump(mode="json")


class TaskFramesEvent(BaseModel):
    """Internal marker describing where a browser frame was captured.

    Not part of the HTTP contract; it travels on the frame manager's own channel
    so the orchestrator can record an ``information_collected`` event with the
    page the agent was actually looking at.
    """

    task_id: str
    url: str | None = None
    title: str | None = None
    captured_at: str = Field(default_factory=now_iso)
    byte_size: int = 0
