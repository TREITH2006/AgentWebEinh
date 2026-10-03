"""Health and status.

``GET /health`` exists purely so the frontend can decide live vs demo mode, so it
answers ``200`` whenever the backend can accept work and carries the full status
document as its body. A richer breakdown is also available at ``/api/status``.

The critical rule: optional integrations never flip the HTTP status. If a missing
Ollama could make ``/health`` fail, the frontend would silently drop into demo mode
for a reason the user cannot see.
"""

from __future__ import annotations

from fastapi import APIRouter, Response, status

from ..schemas.stats import StatusResponse
from .deps import HealthDep

router = APIRouter(tags=["health"])


@router.get("/health", response_model=StatusResponse, summary="Liveness and status")
async def health(health_service: HealthDep, response: Response) -> StatusResponse:
    """Full status document; ``200`` whenever the backend can accept work."""
    snapshot = await health_service.snapshot()
    if not snapshot.healthy:
        # 503 so a load balancer notices, but the body is still the full document.
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return snapshot


@router.get("/api/status", response_model=StatusResponse, summary="Component status")
async def api_status(health_service: HealthDep) -> StatusResponse:
    """Same document as ``/health``, under the versioned path."""
    return await health_service.snapshot()


__all__ = ["router"]
