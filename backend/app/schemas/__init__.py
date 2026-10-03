"""Wire DTOs shared by every layer.

``TaskStatus`` is the closed set the frontend recognises; anything else is
normalised to ``queued`` and would render as a task that never finishes.
"""

from __future__ import annotations

from .event import (
    TERMINAL_EVENT_TYPES,
    EventDto,
    EventType,
    StreamMessage,
    TaskFramesEvent,
)
from .report import FindingDto, SourceDto, TaskActionDto, TaskReportDto
from .stats import (
    RANGE_DAYS,
    BrowserStatusDto,
    ComponentStatusDto,
    OllamaStatusDto,
    OpenClawStatusDto,
    StatsBucketDto,
    StatsRange,
    StatsResponse,
    StatusResponse,
    TinyFishStatusDto,
)
from .task import (
    ACTIVE_STATUSES,
    MAX_PROMPT_LENGTH,
    TERMINAL_STATUSES,
    CreateTaskRequest,
    CreateTaskResponse,
    TaskDto,
    TaskErrorDto,
    TaskFramesDto,
    TaskListQuery,
    TaskListResponse,
    TaskSort,
    TaskStatus,
)

__all__ = [
    "ACTIVE_STATUSES",
    "MAX_PROMPT_LENGTH",
    "RANGE_DAYS",
    "TERMINAL_EVENT_TYPES",
    "TERMINAL_STATUSES",
    "BrowserStatusDto",
    "ComponentStatusDto",
    "CreateTaskRequest",
    "CreateTaskResponse",
    "EventDto",
    "EventType",
    "FindingDto",
    "OllamaStatusDto",
    "OpenClawStatusDto",
    "SourceDto",
    "StatsBucketDto",
    "StatsRange",
    "StatsResponse",
    "StatusResponse",
    "StreamMessage",
    "TaskActionDto",
    "TaskDto",
    "TaskErrorDto",
    "TaskFramesDto",
    "TaskFramesEvent",
    "TaskListQuery",
    "TaskListResponse",
    "TaskReportDto",
    "TaskSort",
    "TaskStatus",
    "TinyFishStatusDto",
]
