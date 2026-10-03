"""``GET /api/stats`` — the analytics payload.

Flat top-level counters with ``buckets`` and ``recent`` at the root, which is what
``normalizeStats`` reads. Both are always present: ``buckets`` dense per UTC day so
the chart's date axis stays truthful, ``recent`` capped.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Query

from ..schemas.stats import StatsResponse
from .deps import MetricsDep

router = APIRouter(prefix="/api", tags=["stats"])


@router.get("/stats", response_model=StatsResponse, summary="Task statistics")
async def stats(
    metrics: MetricsDep,
    range_key: Annotated[str | None, Query(alias="range")] = None,
) -> StatsResponse:
    """Aggregate task statistics.

    An unrecognised ``range`` falls back to ``7d`` rather than returning ``400``:
    this endpoint feeds a chart, and a chart with a default window is more useful
    than an error.
    """
    return await metrics.collect(range_key)


__all__ = ["router"]
