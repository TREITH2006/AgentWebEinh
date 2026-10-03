"""Static guard: every referenced enum member must actually exist.

This exists because of a real outage: the orchestrator and the browser emitter
referenced event types that were never in :class:`EventType` (``TASK_STARTED``,
``STATUS_CHANGED``, ``BROWSER_NAVIGATED`` and six more). Nothing caught it because
the smoke tests never executed a task, so every real run raised ``AttributeError``
on its first emit and failed instantly.

A plain runtime test cannot catch a bad attribute access on a path that only runs
in production, so this walks the source instead. It is cheap and it fails at the
first offending reference.
"""

from __future__ import annotations

import ast
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.schemas.event import EventType

#: ``app`` and ``tests`` next to this file's package root.
PACKAGE_ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIRS = ("app", "tests")

#: Enums whose members are checked, mapped to the import name used in the AST.
CHECKED_ENUMS = {"EventType": EventType}


def _python_files() -> Iterator[Path]:
    for directory in SOURCE_DIRS:
        for path in sorted((PACKAGE_ROOT / directory).rglob("*.py")):
            if "__pycache__" not in path.parts:
                yield path


def _read(path: Path) -> str:
    """Read source, tolerating a stray BOM.

    ``ast.parse`` rejects a leading U+FEFF even though Python's own importer
    accepts it, so the guard must not be stricter than the interpreter.
    """
    return path.read_text(encoding="utf-8-sig")


def _attribute_references(enum_name: str) -> Iterator[tuple[Path, int, str]]:
    """Yield ``(file, line, member)`` for every ``EnumName.MEMBER`` reference."""
    for path in _python_files():
        tree = ast.parse(_read(path), filename=str(path))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and isinstance(node.value, ast.Name)
                and node.value.id == enum_name
            ):
                yield path, node.lineno, node.attr


def test_source_files_are_discovered() -> None:
    """Guard the guard: an empty file list would make the test below vacuous."""
    files = list(_python_files())
    assert len(files) > 20
    assert PACKAGE_ROOT / "app" / "core" / "orchestrator.py" in files


@pytest.mark.parametrize("enum_name", sorted(CHECKED_ENUMS))
def test_every_referenced_enum_member_exists(enum_name: str) -> None:
    """No source file may name a member the enum does not define."""
    members = {member.name for member in CHECKED_ENUMS[enum_name]}

    missing = [
        f"{path.relative_to(PACKAGE_ROOT)}:{line} references {enum_name}.{member}"
        for path, line, member in _attribute_references(enum_name)
        if member not in members
    ]

    assert not missing, "undefined enum members:\n" + "\n".join(sorted(missing))


def test_every_frontend_event_type_is_known_to_the_backend() -> None:
    """The backend's vocabulary must be exactly the frontend's.

    The frontend normalises unknown types to ``log``, so a drifting backend event
    type would silently degrade an activity entry instead of erroring.
    """
    domain = _read(PACKAGE_ROOT.parent / "frontend" / "src" / "types" / "domain.ts")

    # The event union is the block of quoted strings introduced by ``EventType``
    # and terminated by the closing semicolon of that type alias.
    _, _, tail = domain.partition("EventType")
    block = tail.split(";", 1)[0]
    frontend_types = {
        quoted.split('"')[1]
        for quoted in block.split("|")
        if quoted.strip().startswith('"')
    }

    assert frontend_types == {member.value for member in EventType}
