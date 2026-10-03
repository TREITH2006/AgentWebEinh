"""Application factory and composition root.

Every component is constructed exactly once here and attached to ``app.state``.
Doing the wiring in one function is what makes the dependency graph auditable:
the adapter list, the repositories, the services and the manager are all visible
in a single screen, and :mod:`app.api.deps` only ever *reads* from ``app.state``.

Startup order is deliberate:

1. create the schema (idempotent) so anything can query immediately;
2. recover tasks abandoned by a previous process, then re-queue the ones that were
   only waiting;
3. start the worker pool, so a re-queued task cannot be picked up before recovery
   has finished;
4. start the HTTP server last.

Shutdown reverses it, and requests cooperative cancellation before tearing
anything down so in-flight runs settle as ``cancelled`` rather than being killed
mid-write.
"""

from __future__ import annotations

import contextlib
import logging
import sys
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .adapters.browser_adapter import BrowserAdapter
from .adapters.ollama_adapter import OllamaAdapter
from .adapters.openclaw_adapter import OpenClawAdapter
from .adapters.tinyfish_adapter import TinyFishAdapter
from .api import all_routers
from .browser.browser_manager import BrowserManager
from .browser.frame_manager import FrameManager
from .config import Settings, get_settings
from .core.event_manager import EventManager
from .core.orchestrator import Orchestrator
from .core.task_manager import TaskContext, TaskManager
from .database.database import Database
from .database.repositories import EventRepository, TaskRepository
from .errors import register_exception_handlers
from .services.health_service import HealthService
from .services.metrics_service import MetricsService
from .services.report_service import ReportService
from .services.task_service import TaskService
from .utils.time import now_iso

logger = logging.getLogger("agentwebeinh")


def configure_logging(settings: Settings) -> None:
    """Send structured, redacted logs to stdout.

    Log level and format come from settings rather than being hard-coded, so a
    deployment can turn up verbosity without a code change.
    """
    logging.basicConfig(
        level=getattr(logging, settings.log_level),
        format="%(asctime)s %(levelname)-8s %(name)s %(message)s",
        stream=sys.stdout,
        force=True,
    )
    # These are chatty at DEBUG and drown out the application's own lines.
    for noisy in ("httpx", "httpcore", "asyncio", "aiosqlite"):
        logging.getLogger(noisy).setLevel(max(logging.WARNING, getattr(logging, settings.log_level)))


def build_component_graph(
    app: FastAPI,
    settings: Settings,
    orchestrator_factory: Any = None,
) -> None:
    """Construct every component and attach it to ``app.state``.

    ``orchestrator_factory`` overrides how a queued task is executed. Production
    passes ``None`` and gets the real orchestrator; tests pass a stub so the HTTP
    contract can be exercised without launching Chromium or calling a model.
    """
    database = Database(settings)
    # Repositories are stateless: they take their collaborators per call.
    task_repository = TaskRepository()
    event_repository = EventRepository()

    # A provisional task service gives the event manager a snapshot source; it
    # reads from the database and is stateless, so the swap is not observable.
    task_service = TaskService(database, settings, task_repository, event_repository)
    event_manager = EventManager(
        database, settings, event_repository, task_service.get_task
    )

    ollama = OllamaAdapter(settings)
    openclaw = OpenClawAdapter(settings)
    tinyfish = TinyFishAdapter(settings)
    frames = FrameManager(settings)
    browser = BrowserManager(settings)
    browser_adapter = BrowserAdapter(settings, browser, ollama)
    reports = ReportService(settings, ollama)

    task_manager = TaskManager(
        database=database,
        settings=settings,
        tasks=task_repository,
        events=event_repository,
        event_manager=event_manager,
        orchestrator_factory=orchestrator_factory
        or _make_orchestrator_factory(
            settings=settings,
            browser=browser_adapter,
            ollama=ollama,
            openclaw=openclaw,
            frames=frames,
            reports=reports,
        ),
    )

    metrics = MetricsService(settings, database, task_repository, task_service)
    health = HealthService(
        settings=settings,
        database=database,
        task_manager=task_manager,
        ollama=ollama,
        openclaw=openclaw,
        browser=browser,
        tinyfish=tinyfish,
        frames=frames,
    )

    app.state.settings = settings
    app.state.database = database
    app.state.task_repository = task_repository
    app.state.event_repository = event_repository
    app.state.task_service = task_service
    app.state.event_manager = event_manager
    app.state.task_manager = task_manager
    app.state.metrics_service = metrics
    app.state.health_service = health
    app.state.reports = reports
    app.state.frames = frames
    app.state.browser = browser
    app.state.browser_adapter = browser_adapter
    app.state.ollama = ollama
    app.state.openclaw = openclaw
    app.state.tinyfish = tinyfish
    app.state.started_at = now_iso()


def _make_orchestrator_factory(**components: Any) -> Any:
    """Build the callable ``TaskManager`` uses to run a task.

    Wrapped in a factory so the orchestrator and its adapters are constructed per
    run rather than shared, keeping their internal state (last decision, page list)
    scoped to one task even if the objects ever become stateful.
    """

    async def factory(context: TaskContext) -> None:
        orchestrator = Orchestrator(**components)
        await orchestrator(context)

    return factory


def register_middleware(app: FastAPI, settings: Settings) -> None:
    """CORS for the local frontend.

    A specific allow-list, never ``*``: with credentials enabled a wildcard origin
    is both invalid and unsafe. ``allow_origin_regex`` exists so a preview
    deployment can be allowed without editing code.
    """
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_origin_regex=settings.allow_origin_regex,
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "Accept", "X-Client-Request-Id"],
        max_age=600,
    )


def register_routes(app: FastAPI) -> None:
    for router in all_routers:
        app.include_router(router)

    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, str]:
        """A tiny index so hitting the API in a browser is not a 404."""
        return {
            "service": app.state.settings.app_name,
            "docs": "/docs",
            "health": "/health",
        }


async def _lifespan(app: FastAPI) -> Any:
    settings: Settings = app.state.settings
    database: Database = app.state.database
    task_manager: TaskManager = app.state.task_manager
    frames: FrameManager = app.state.frames
    browser: BrowserManager = app.state.browser
    ollama: OllamaAdapter = app.state.ollama

    logger.info(
        "startup environment=%s public_base_url=%s database=%s",
        settings.environment,
        settings.public_base_url,
        settings.database_file,
    )
    # ``Database`` creates its parent directory and the engine lazily, so startup
    # only has to make sure the schema exists before workers touch it.
    await database.init_schema()

    # Recover before starting workers so a re-queued task cannot start while the
    # previous process's rows are still being reconciled.
    recovered = await task_manager.recover_interrupted()
    requeued = await task_manager.enqueue_pending()
    if recovered or requeued:
        logger.info(
            "startup_recovery interrupted_failed=%s requeued=%s", recovered, requeued
        )

    await task_manager.start()
    app.state.ready = True
    logger.info("startup_complete")

    try:
        yield
    finally:
        app.state.ready = False
        logger.info("shutdown_begin")
        await task_manager.stop()
        await frames.clear_all()
        await browser.stop()
        await ollama.close()
        await database.dispose()
        logger.info("shutdown_complete")


def create_app(settings: Settings | None = None, orchestrator_factory: Any = None) -> FastAPI:
    """Build the ASGI application.

    ``orchestrator_factory`` is a testing seam; see
    :func:`build_component_graph`.
    """
    resolved = settings or get_settings()
    configure_logging(resolved)

    app = FastAPI(
        title=resolved.app_name,
        version="1.0.0",
        description=(
            "Backend for AgentWebEinh: local browser-automation task runner with "
            "SQLite-backed task history, a WebSocket event stream and live browser "
            "frames."
        ),
        lifespan=_lifespan,
    )

    build_component_graph(app, resolved, orchestrator_factory)
    register_middleware(app, resolved)
    register_exception_handlers(app)
    register_routes(app)
    return app


#: Module-level app for ``uvicorn app.main:app``.
app = create_app()


def main() -> None:
    """Run the backend with uvicorn.

    Importable as ``python -m app.main`` so the exact interpreter from
    ``backend\\.venv`` is used without relying on an activated shell.
    """
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
        log_config=None,  # logging is already configured above
    )


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        main()


__all__ = ["app", "build_component_graph", "configure_logging", "create_app", "main"]
