"""Wire DTOs for the statistics endpoint.

The aggregate counters are **flat and top-level**, matching the example in
``docs/API_CONTRACT.md``. ``normalizeStats`` looks for a nested ``totals`` object
first and falls back to the root object when it is absent, so the flat shape is
both valid and the cheaper one to emit.

``buckets`` and ``recent`` are always read from the root object and must never be
nested inside ``totals``.

Buckets are dense: one entry per UTC calendar day in the requested range, oldest
first, with zeroed counters for days that saw no activity, because the charts
place points by date and would otherwise distort the axis.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .task import TaskDto

StatsRange = Literal["7d", "30d", "90d"]

#: Days covered by each supported range. ``7d`` is today plus the previous six
#: calendar days, matching ``day_window(7)`` in ``utils/time.py``.
RANGE_DAYS: dict[str, int] = {"7d": 7, "30d": 30, "90d": 90}


class StatsBucketDto(BaseModel):
    """Aggregates for a single UTC calendar day."""

    date: str
    performed: int = 0
    completed: int = 0
    failed: int = 0
    cancelled: int = 0
    #: Average duration of the tasks that settled that day; ``None`` when none did.
    duration_ms: int | None = None
    #: completed / (completed + failed) for that day; ``None`` when undefined.
    success_rate: float | None = Field(default=None, ge=0.0, le=1.0)


class StatsResponse(BaseModel):
    """``GET /api/stats`` body."""

    total_tasks: int = 0
    completed_tasks: int = 0
    failed_tasks: int = 0
    cancelled_tasks: int = 0
    #: completed / (completed + failed), as 0..1.
    success_rate: float = Field(default=0.0, ge=0.0, le=1.0)
    average_duration_ms: int | None = None
    #: Echo of the requested range, so the client can label its own view.
    range: str = "7d"
    buckets: list[StatsBucketDto] = Field(default_factory=list)
    recent: list[TaskDto] = Field(default_factory=list)


class ComponentStatusDto(BaseModel):
    """State of one dependency.

    ``state`` is a short machine token; ``detail`` is a human sentence safe to
    show in a status panel. Neither ever contains a credential.
    """

    state: str
    detail: str | None = None
    latency_ms: int | None = None
    version: str | None = None


class OllamaStatusDto(ComponentStatusDto):
    base_url: str
    model: str
    model_available: bool
    embedding_model: str | None = None
    embedding_model_available: bool | None = None


class OpenClawStatusDto(ComponentStatusDto):
    gateway_url: str
    gateway_reachable: bool
    cli_available: bool
    #: Plugins the gateway reports as loaded. Informational only.
    plugins: list[str] = Field(default_factory=list)


class BrowserStatusDto(ComponentStatusDto):
    engine: str
    playwright_available: bool
    chromium_available: bool
    active_sessions: int = 0


class TinyFishStatusDto(ComponentStatusDto):
    cli_available: bool
    enabled: bool


class StatusResponse(BaseModel):
    """``GET /api/status`` and ``GET /api/health`` body.

    ``healthy`` is true only when the backend can actually accept work: the
    database is reachable and the task manager is running. An optional
    integration being down degrades its own field but never flips ``healthy``,
    so a missing Ollama cannot make the frontend fall back to demo mode.
    """

    status: Literal["healthy", "degraded", "unhealthy"]
    healthy: bool
    version: str
    environment: str
    server_time: str
    uptime_seconds: float
    public_base_url: str
    components: dict[str, ComponentStatusDto] = Field(default_factory=dict)
    openclaw: OpenClawStatusDto | None = None
    ollama: OllamaStatusDto | None = None
    browser: BrowserStatusDto | None = None
    tinyfish: TinyFishStatusDto | None = None
    notes: list[str] = Field(default_factory=list)
