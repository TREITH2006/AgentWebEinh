"""Shared fixtures.

Every test runs against a **temporary** SQLite file inside the project's ``data``
directory and with a stub orchestrator, so the suite never launches Chromium,
never calls Ollama and never touches a real task history.

The stub orchestrator still walks the real state machine and commits a real
report, which is what makes the contract assertions meaningful.
"""

from __future__ import annotations

import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.config import DATA_DIR, Settings, settings_override  # noqa: E402
from app.main import create_app  # noqa: E402
from app.schemas.event import EventType  # noqa: E402
from app.schemas.task import TaskStatus  # noqa: E402

#: The stub's report, asserted on by the contract tests.
STUB_REPORT: dict[str, Any] = {
    "summary": "The stub orchestrator confirmed the run reached a terminal state.",
    "actions": [
        {
            "index": 1,
            "at": "2026-01-14T09:00:00.000000Z",
            "label": "Opened a URL directly",
            "target": "#awe-1",
            "status": "performed",
        }
    ],
    "findings": [
        {
            "label": "Stub finding",
            "value": "The orchestrator seam returned a deterministic report.",
            "sourceUrl": "https://example.com/stub",
        }
    ],
    "sources": [{"url": "https://example.com/stub", "title": "Stub", "domain": "example.com"}],
    "limitations": ["Produced by a test double, not a real browser run."],
}


async def stub_orchestrator(context: Any) -> None:
    """A run that behaves like the real orchestrator without any I/O.

    It performs the same status walk and commits a report through the same
    :class:`TaskContext` methods the orchestrator uses, so the observable contract
    is identical to production.
    """
    await context.transition(TaskStatus.STARTING)
    await context.emit(EventType.AGENT_STARTED, "Starting the task.")
    await context.transition(TaskStatus.RUNNING)
    await context.update(current_activity="Doing stub work", progress=0.5)
    await context.emit(
        EventType.LOG,
        "Task is running.",
        data={"status": TaskStatus.RUNNING.value},
    )
    await context.emit(EventType.BROWSER_OPENED, "Opened the stub page", url="https://example.com/stub")
    await context.emit(EventType.INFORMATION_COLLECTED, "Collected Stub finding",
                      url="https://example.com/stub",
                      data={"label": "Stub finding", "value": "Confirmed."})
    await context.complete(STUB_REPORT, message="Task completed.")


@pytest.fixture
def stub_factory() -> Any:
    async def factory(context: Any) -> None:
        await stub_orchestrator(context)

    return factory


@pytest.fixture
def settings() -> Iterator[Settings]:
    """Settings pointed at a throwaway database inside the project's data dir.

    The path must be project-local: ``Settings`` refuses any ``database_file``
    outside the repository, which is deliberate for the real deployment and applies
    to tests too. The file (plus SQLite's ``-wal``/``-shm`` siblings) is deleted
    afterwards so a run leaves no history behind.
    """
    database_file = DATA_DIR / "test-tasks" / f"tasks-{uuid4().hex}.db"
    resolved = settings_override(
        database_file=database_file,
        environment="test",
        # No integration may do real I/O in the suite: no Chromium, no model, no
        # gateway, no paid CLI. The contract tests only exercise the HTTP surface.
        browser_enabled=False,
        ollama_enabled=False,
        openclaw_enabled=False,
        tinyfish_enabled=False,
        max_concurrent_tasks=2,
        task_timeout_seconds=30,
        log_level="WARNING",
    )
    try:
        yield resolved
    finally:
        for path in (
            database_file,
            database_file.with_name(f"{database_file.name}-wal"),
            database_file.with_name(f"{database_file.name}-shm"),
        ):
            path.unlink(missing_ok=True)


@pytest.fixture
def app(settings: Settings, stub_factory: Any) -> Any:
    return create_app(settings, orchestrator_factory=stub_factory)


@pytest.fixture
def client(app: Any) -> Iterator[Any]:
    """In-process HTTP client.

    ``TestClient`` drives the ASGI app directly, so no socket is bound and no
    server process starts. Entering the context runs the lifespan, which is what
    creates the schema and starts the (stubbed) worker pool.
    """
    from fastapi.testclient import TestClient

    with TestClient(app) as test_client:
        yield test_client
