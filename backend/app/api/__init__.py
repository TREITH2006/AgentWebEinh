"""HTTP transport layer.

Routers are thin: they validate, call a service, and shape a response. No business
logic and no direct database access live here.
"""

from __future__ import annotations

from fastapi import APIRouter

from .browser_ws import router as browser_ws_router
from .events import router as events_router
from .frames import router as frames_router
from .health import router as health_router
from .stats import router as stats_router
from .tasks import router as tasks_router
from .websocket import router as websocket_router

#: Every router, in one place, so ``main`` has a single import to wire.
all_routers: tuple[APIRouter, ...] = (
    health_router,
    tasks_router,
    events_router,
    frames_router,
    stats_router,
    websocket_router,
    browser_ws_router,
)

__all__ = [
    "all_routers",
    "browser_ws_router",
    "events_router",
    "frames_router",
    "health_router",
    "stats_router",
    "tasks_router",
    "websocket_router",
]
