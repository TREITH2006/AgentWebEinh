"""Command-line entry points.

Kept separate from the package modules so ``python -m app.cli`` does not re-import
an already-imported module (which makes ``runpy`` emit a RuntimeWarning).

Usage::

    python -m app.cli init-db      # create the SQLite schema (idempotent)
    python -m app.cli config       # print the effective settings
    python -m app.cli routes       # list the HTTP routes
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from .config import get_settings
from .database.database import Database, set_database

logger = logging.getLogger("agentwebeinh.cli")


def _init_db() -> int:
    settings = get_settings()
    Path(settings.database_file).parent.mkdir(parents=True, exist_ok=True)
    database = Database(settings)

    async def run() -> None:
        try:
            await database.init_schema()
        finally:
            await database.dispose()

    asyncio.run(run())
    set_database(None)
    print(f"schema ready: {settings.database_file}")
    return 0


def _config() -> int:
    """Print the effective settings.

    Secrets are never printed: only the settings objects actually hold, and the
    adapters read their credentials from the environment rather than config.
    """
    settings = get_settings()
    for field, value in sorted(settings.model_dump().items()):
        print(f"{field} = {value}")
    return 0


def _routes() -> int:
    from .main import create_app

    schema = create_app().openapi()
    for path, operations in sorted(schema["paths"].items()):
        print(f"{','.join(sorted(m.upper() for m in operations)):<12} {path}")
    print(f"total paths: {len(schema['paths'])}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__)
    parser.add_argument(
        "command",
        nargs="?",
        default="init-db",
        choices=["init-db", "config", "routes"],
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")

    if args.command == "init-db":
        return _init_db()
    if args.command == "config":
        return _config()
    return _routes()


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    sys.exit(main())
