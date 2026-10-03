"""Wire DTOs for tasks.

Field names here are the **canonical snake_case** spelling documented in
``docs/API_CONTRACT.md``. The frontend's ``normalize.ts`` accepts snake_case and
camelCase for every field, so these names serialise directly onto the contract.

Two values are load-bearing and must not be "helpfully" defaulted:

``progress: null``
    Renders an indeterminate bar. The frontend never invents a ratio, so a
    missing value must stay ``null`` rather than becoming ``0``.
``report: null``
    The UI says "no report returned" instead of showing empty panels.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..utils.time import now_iso
from .report import TaskReportDto

#: Contract limit enforced by the frontend composer. ``AWE_PROMPT_MAX_LENGTH``
#: may lower it at runtime but never raise it above what the UI allows.
MAX_PROMPT_LENGTH = 2000

TaskSort = Literal["newest", "oldest", "longest", "shortest"]


class TaskStatus(str, Enum):
    """The only eight statuses the frontend recognises.

    ``normalizeStatus`` maps anything unrecognised to ``queued``, which renders
    as an active spinner. Emitting an unknown status therefore looks like a task
    that never finishes, so this enum is closed on purpose.
    """

    READY = "ready"
    QUEUED = "queued"
    STARTING = "starting"
    RUNNING = "running"
    AWAITING_APPROVAL = "awaiting_approval"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


#: Statuses after which the backend must stop pushing updates.
TERMINAL_STATUSES: frozenset[TaskStatus] = frozenset(
    {TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED}
)

#: Statuses for which the Stop control is offered in the frontend.
ACTIVE_STATUSES: frozenset[TaskStatus] = frozenset(
    {
        TaskStatus.QUEUED,
        TaskStatus.STARTING,
        TaskStatus.RUNNING,
        TaskStatus.AWAITING_APPROVAL,
    }
)


class TaskErrorDto(BaseModel):
    """Why a task failed. ``retryable`` drives the frontend's retry affordance."""

    message: str
    code: str | None = None
    retryable: bool | None = None


class TaskDto(BaseModel):
    """A task as returned by ``GET /api/tasks/{id}`` and friends.

    Timestamps are fixed-width ISO-8601 UTC strings, and ``duration_ms`` is
    milliseconds. ``progress`` is a 0..1 ratio or ``null``.
    """

    model_config = ConfigDict(populate_by_name=True)

    id: str
    prompt: str
    status: TaskStatus
    created_at: str
    title: str | None = None
    started_at: str | None = None
    completed_at: str | None = None
    duration_ms: int | None = None
    progress: float | None = Field(default=None, ge=0.0, le=1.0)
    current_activity: str | None = None
    current_url: str | None = None
    current_title: str | None = None
    error: TaskErrorDto | None = None
    report: TaskReportDto | None = None

    @field_validator("current_url")
    @classmethod
    def _absolute_url(cls, value: str | None) -> str | None:
        """Reject non-absolute or non-HTTP URLs.

        The frontend's ``asUrl()`` drops anything ``new URL()`` cannot parse as
        http(s), so storing a relative value would silently blank the field.
        """
        if value is None or value == "":
            return None
        text = value.strip()
        if not text.startswith(("http://", "https://")):
            return None
        return text


class CreateTaskRequest(BaseModel):
    """``POST /api/tasks`` body.

    The frontend always sends ``clientRequestId`` (a ``crypto.randomUUID()``).
    It is treated as an idempotency key: repeating it returns the original task
    instead of starting a second run.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_LENGTH)
    client_request_id: str | None = Field(default=None, alias="clientRequestId")

    @field_validator("prompt")
    @classmethod
    def _strip_prompt(cls, value: str) -> str:
        text = " ".join(value.split())
        if not text:
            raise ValueError("prompt must contain at least one non-whitespace character")
        return text


class CreateTaskResponse(BaseModel):
    """``201`` body.

    The frontend reads ``id``/``task_id``/``taskId`` and requires one of them, so
    ``id`` is always present. Status is always ``queued``: execution happens in
    the background so the request returns immediately.
    """

    id: str
    status: TaskStatus = TaskStatus.QUEUED
    created_at: str = Field(default_factory=now_iso)


class TaskListResponse(BaseModel):
    """``GET /api/tasks`` body. ``items`` and ``total`` must be top-level."""

    items: list[TaskDto] = Field(default_factory=list)
    total: int = 0
    limit: int = 0
    offset: int = 0


class TaskListQuery(BaseModel):
    """Parsed query parameters for the task list."""

    search: str | None = None
    status: TaskStatus | None = None
    sort: TaskSort = "newest"
    limit: int = 25
    offset: int = 0


class TaskFramesDto(BaseModel):
    """``GET /api/tasks/{id}/frames`` body.

    URLs are absolute because the frontend renders them in a bare ``<img>`` and
    rejects relative ones. Both may be ``null`` when no browser session exists,
    which makes the UI state that plainly instead of faking a screenshot.
    """

    task_id: str | None = None
    frames_url: str | None = None
    snapshot_url: str | None = None
    captured_at: str | None = None
    width: int | None = None
    height: int | None = None
    engine: str | None = None

    def as_wire(self) -> dict[str, Any]:
        """Serialise with the snake_case keys the frontend expects."""
        return self.model_dump(mode="json")
