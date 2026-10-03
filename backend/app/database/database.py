"""Async SQLite engine, session factory and schema management.

Design notes
------------
*WAL journalling* is enabled so the orchestrator's writes never block a reader
serving ``GET /api/tasks``. ``busy_timeout`` absorbs the short lock contention
that remains when several task workers write concurrently.

*Foreign keys are on.* SQLite disables them per-connection by default, which
would let orphaned events survive a task deletion.

Schema creation is idempotent (``CREATE TABLE IF NOT EXISTS``) and never drops
data: restarting the backend must not lose task history.

This module can be run directly to create the schema **without starting the
application**::

    backend\\.venv\\Scripts\\python.exe -m app.cli init-db
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import warnings
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from ..config import Settings, get_settings
from .models import Base

logger = logging.getLogger("agentwebeinh.database")


def _apply_sqlite_pragmas(engine: AsyncEngine) -> None:
    """Configure each new SQLite connection.

    Registered on the sync engine because SQLAlchemy exposes DBAPI-level events
    there; aiosqlite proxies the same underlying connection.
    """

    @event.listens_for(engine.sync_engine, "connect")
    def _set_pragmas(dbapi_connection: Any, _connection_record: Any) -> None:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA foreign_keys=ON")
            # Concurrent task workers retry rather than failing instantly.
            cursor.execute("PRAGMA busy_timeout=5000")
        finally:
            cursor.close()

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_hooks(dbapi_connection: Any, _record: Any) -> None:
        """Keep ``sqlite3`` from handing out advisory locks it cannot hold."""
        try:
            dbapi_connection.isolation_level = None  # autocommit; we manage txns
        except (AttributeError, TypeError):  # pragma: no cover - driver dependent
            logger.debug("could_not_set_isolation_level")


class Database:
    """Owns the engine and hands out sessions."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._engine: AsyncEngine | None = None
        self._sessionmaker: async_sessionmaker[AsyncSession] | None = None

    # ------------------------------------------------------------- lifecycle --

    def _ensure_engine(self) -> AsyncEngine:
        if self._engine is None:
            self._settings.database_file.parent.mkdir(parents=True, exist_ok=True)
            self._engine = create_async_engine(
                self._settings.database_url,
                echo=False,
                future=True,
                # SQLite has a single writer; a small pool avoids thrashing.
                pool_size=5,
                max_overflow=5,
                connect_args={"check_same_thread": False},
            )
            _apply_sqlite_pragmas(self._engine)
            self._sessionmaker = async_sessionmaker(
                self._engine, expire_on_commit=False, class_=AsyncSession
            )
        return self._engine

    @property
    def engine(self) -> AsyncEngine:
        return self._ensure_engine()

    @property
    def sessionmaker(self) -> async_sessionmaker[AsyncSession]:
        self._ensure_engine()
        assert self._sessionmaker is not None
        return self._sessionmaker

    @asynccontextmanager
    async def session(self) -> AsyncIterator[AsyncSession]:
        """Transactional scope: commits on success, rolls back on error."""
        async with self.sessionmaker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def init_schema(self) -> None:
        """Create tables if absent. Existing rows are never touched."""
        engine = self._ensure_engine()
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        logger.info("schema_ready path=%s", self._settings.database_file)

    async def ping(self) -> bool:
        """Cheap liveness check used by the status endpoint."""
        try:
            async with self.engine.connect() as connection:
                await connection.execute(text("SELECT 1"))
            return True
        except Exception as exc:  # noqa: BLE001 - health must never raise
            logger.warning("database_ping_failed error=%s", type(exc).__name__)
            return False

    async def dispose(self) -> None:
        if self._engine is not None:
            await self._engine.dispose()
            self._engine = None
            self._sessionmaker = None


_database: Database | None = None


def get_database() -> Database:
    """Process-wide :class:`Database` singleton."""
    global _database
    if _database is None:
        _database = Database(get_settings())
    return _database


def set_database(database: Database | None) -> None:
    """Replace the singleton (used by tests and by the app factory)."""
    global _database
    _database = database


# ------------------------------------------------------------------ schema CLI --


async def _init_schema(settings: Settings) -> int:
    """Create the schema if absent. Never drops or migrates existing data."""
    database = Database(settings)
    try:
        await database.init_schema()
    finally:
        await database.dispose()
    print(f"schema ready: {settings.database_file}")
    return 0


def main(argv: list[str] | None = None) -> int:
    """Deprecated shim. Use ``python -m app.cli init-db`` instead.

    Kept so an older invocation keeps working; ``app.cli`` exists because running
    this module directly makes ``runpy`` re-import it and emit a RuntimeWarning.
    """
    warnings.warn(
        "python -m app.database.database is deprecated; use python -m app.cli init-db",
        DeprecationWarning,
        stacklevel=2,
    )
    return _main(argv)


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli init-db",
        description="Create the SQLite schema without starting the API server.",
    )
    parser.add_argument(
        "command",
        nargs="?",
        default="init",
        choices=["init"],
        help="'init' creates tables if they do not exist (never drops data)",
    )
    # Parsed for its side effect only: argparse rejects any command but "init",
    # which is the entire behaviour this shim offers.
    parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    settings = get_settings()
    Path(settings.database_file).parent.mkdir(parents=True, exist_ok=True)
    return asyncio.run(_init_schema(settings))


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(_main())
