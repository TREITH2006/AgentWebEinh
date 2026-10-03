"""Statistics aggregation for ``GET /api/stats``.

Two different windows, deliberately:

* the **headline counters** describe all history, because "how many tasks have
  failed overall" is not a range question;
* the **buckets** describe the requested range and are dense, so the frontend
  chart's date axis is never distorted by missing days.

Day attribution is UTC and outcome-based: a task counts towards the day it
*settled*, which is what "how many failed on Tuesday" actually means.
"""

from __future__ import annotations

import logging

from ..config import Settings
from ..database.database import Database
from ..database.repositories import TaskRepository
from ..schemas.stats import RANGE_DAYS, StatsBucketDto, StatsResponse
from ..services.task_service import TaskService
from ..utils.time import day_window, enumerate_day_keys

logger = logging.getLogger("agentwebeinh.metrics")

DEFAULT_RANGE = "7d"
#: How many recent tasks the analytics view shows.
RECENT_LIMIT = 5


class MetricsService:
    """Builds the statistics payload."""

    def __init__(
        self,
        settings: Settings,
        database: Database,
        tasks: TaskRepository,
        task_service: TaskService,
    ) -> None:
        self._settings = settings
        self._database = database
        self._tasks = tasks
        self._task_service = task_service

    def normalize_range(self, requested: str | None) -> str:
        """Accept only a supported range; fall back rather than 400 on junk."""
        if requested and requested in RANGE_DAYS:
            return requested
        if requested:
            logger.info("stats_range_unrecognised value=%r; using %s", requested, DEFAULT_RANGE)
        return DEFAULT_RANGE

    async def collect(self, requested_range: str | None = None) -> StatsResponse:
        range_key = self.normalize_range(requested_range)
        days = RANGE_DAYS[range_key]
        start, end = day_window(days)

        async with self._database.session() as session:
            lifetime = await self._tasks.lifetime_counts(session)
            average = await self._tasks.lifetime_average_duration_ms(session)
            performed = await self._tasks.performed_per_day(session, start=start, end=end)
            outcomes = await self._tasks.outcomes_per_day(session, start=start, end=end)

        completed = lifetime.get("completed", 0)
        failed = lifetime.get("failed", 0)
        total = sum(lifetime.values())

        return StatsResponse(
            total_tasks=total,
            completed_tasks=completed,
            failed_tasks=failed,
            cancelled_tasks=lifetime.get("cancelled", 0),
            success_rate=_success_rate(completed, failed),
            average_duration_ms=average,
            range=range_key,
            buckets=_buckets(days, performed, outcomes),
            recent=await self._task_service.recent_tasks(RECENT_LIMIT),
        )


def _success_rate(completed: int, failed: int) -> float:
    """completed / (completed + failed), or 0 when nothing settled yet.

    Cancelled tasks are excluded: a user-cancelled run is not a failure of the
    system, and counting it would make a healthy fleet look broken.
    """
    denominator = completed + failed
    if denominator <= 0:
        return 0.0
    return round(completed / denominator, 4)


def _buckets(
    days: int,
    performed: dict[str, int],
    outcomes: dict[str, dict[str, float]],
) -> list[StatsBucketDto]:
    """One dense bucket per UTC day, oldest first."""
    buckets: list[StatsBucketDto] = []
    for day in enumerate_day_keys(days):
        outcome = outcomes.get(day, {})
        completed = int(outcome.get("completed", 0))
        failed = int(outcome.get("failed", 0))
        raw_average = outcome.get("avg_duration_ms")
        buckets.append(
            StatsBucketDto(
                date=day,
                performed=performed.get(day, 0),
                completed=completed,
                failed=failed,
                cancelled=int(outcome.get("cancelled", 0)),
                duration_ms=int(raw_average) if raw_average is not None else None,
                success_rate=_success_rate(completed, failed) or None,
            )
        )
    return buckets


__all__ = ["DEFAULT_RANGE", "MetricsService"]
