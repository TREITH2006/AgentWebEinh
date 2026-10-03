"""FastAPI dependency wiring.

Components are constructed once in :mod:`app.main` and stored on ``app.state``;
this module exposes them to route handlers. Nothing here instantiates a service,
so a route can never accidentally create a second database pool or browser.
"""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import Depends, Request

from ..adapters.browser_adapter import BrowserAdapter
from ..adapters.ollama_adapter import OllamaAdapter
from ..adapters.openclaw_adapter import OpenClawAdapter
from ..adapters.tinyfish_adapter import TinyFishAdapter
from ..browser.browser_manager import BrowserManager
from ..browser.frame_manager import FrameManager
from ..config import Settings
from ..core.event_manager import EventManager
from ..core.task_manager import TaskManager
from ..database.database import Database
from ..database.repositories import EventRepository, TaskRepository
from ..services.health_service import HealthService
from ..services.metrics_service import MetricsService
from ..services.report_service import ReportService
from ..services.task_service import TaskService


def _state(request: Request) -> object:
    return request.app.state


def get_settings_dep(request: Request) -> Settings:
    return cast(Settings, _state(request).settings)


def get_database(request: Request) -> Database:
    return cast(Database, _state(request).database)


def get_task_manager(request: Request) -> TaskManager:
    return cast(TaskManager, _state(request).task_manager)


def get_event_manager(request: Request) -> EventManager:
    return cast(EventManager, _state(request).event_manager)


def get_task_service(request: Request) -> TaskService:
    return cast(TaskService, _state(request).task_service)


def get_metrics_service(request: Request) -> MetricsService:
    return cast(MetricsService, _state(request).metrics_service)


def get_health_service(request: Request) -> HealthService:
    return cast(HealthService, _state(request).health_service)


def get_frame_manager(request: Request) -> FrameManager:
    return cast(FrameManager, _state(request).frames)


def get_browser_manager(request: Request) -> BrowserManager:
    return cast(BrowserManager, _state(request).browser)


def get_task_repository(request: Request) -> TaskRepository:
    return cast(TaskRepository, _state(request).task_repository)


def get_event_repository(request: Request) -> EventRepository:
    return cast(EventRepository, _state(request).event_repository)


def get_ollama(request: Request) -> OllamaAdapter:
    return cast(OllamaAdapter, _state(request).ollama)


def get_openclaw(request: Request) -> OpenClawAdapter:
    return cast(OpenClawAdapter, _state(request).openclaw)


def get_tinyfish(request: Request) -> TinyFishAdapter:
    return cast(TinyFishAdapter, _state(request).tinyfish)


def get_browser_adapter(request: Request) -> BrowserAdapter:
    return cast(BrowserAdapter, _state(request).browser_adapter)


def get_report_service(request: Request) -> ReportService:
    return cast(ReportService, _state(request).reports)


SettingsDep = Annotated[Settings, Depends(get_settings_dep)]
TaskManagerDep = Annotated[TaskManager, Depends(get_task_manager)]
EventManagerDep = Annotated[EventManager, Depends(get_event_manager)]
TaskServiceDep = Annotated[TaskService, Depends(get_task_service)]
MetricsDep = Annotated[MetricsService, Depends(get_metrics_service)]
HealthDep = Annotated[HealthService, Depends(get_health_service)]
FrameManagerDep = Annotated[FrameManager, Depends(get_frame_manager)]
TaskRepositoryDep = Annotated[TaskRepository, Depends(get_task_repository)]
OllamaDep = Annotated[OllamaAdapter, Depends(get_ollama)]

__all__ = [
    "EventManagerDep",
    "FrameManagerDep",
    "HealthDep",
    "MetricsDep",
    "OllamaDep",
    "SettingsDep",
    "TaskManagerDep",
    "TaskRepositoryDep",
    "TaskServiceDep",
    "get_browser_adapter",
    "get_browser_manager",
    "get_database",
    "get_event_manager",
    "get_event_repository",
    "get_frame_manager",
    "get_health_service",
    "get_metrics_service",
    "get_ollama",
    "get_openclaw",
    "get_report_service",
    "get_settings_dep",
    "get_task_manager",
    "get_task_repository",
    "get_task_service",
    "get_tinyfish",
]
