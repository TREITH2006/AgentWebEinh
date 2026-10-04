"""The documented environment must match the settings that actually exist.

An ``.env.example`` that names a removed setting, omits one that matters, or
quotes a stale default is worse than no example at all: it is confidently wrong.
These tests read the file and compare it against :class:`Settings`.
"""

from __future__ import annotations

import os
import re
import tomllib
from pathlib import Path

import pytest

from app.config import ENV_PREFIX, Settings

BACKEND_DIR = Path(__file__).resolve().parents[1]
EXAMPLE = BACKEND_DIR / ".env.example"

#: Matches an assignment, active or commented out. Prose comments contain "="
#: too, so a line only counts when it really looks like a variable.
_ASSIGNMENT = re.compile(rf"#?\s*({ENV_PREFIX}[A-Z0-9_]+)=")


def _documented_keys() -> set[str]:
    """Setting names from the example, prefix stripped and lower-cased.

    Environment variables are upper-case by convention while Pydantic fields are
    lower-case, so both sides are compared in lower-case. Commented-out entries
    count as documented: they are shown deliberately, unset.
    """
    keys: set[str] = set()
    for raw in EXAMPLE.read_text(encoding="utf-8-sig").splitlines():
        match = _ASSIGNMENT.match(raw.strip())
        if match is not None:
            keys.add(match.group(1)[len(ENV_PREFIX) :].lower())
    return keys


def test_example_file_exists() -> None:
    assert EXAMPLE.is_file(), "backend/.env.example is part of the documented setup"


def test_every_documented_variable_is_a_real_setting() -> None:
    unknown = _documented_keys() - set(Settings.model_fields)

    assert not unknown, (
        ".env.example documents variables that Settings does not define: "
        f"{sorted(unknown)}"
    )


def test_every_setting_is_documented() -> None:
    """The reverse direction: an undocumented setting cannot be discovered."""
    missing = set(Settings.model_fields) - _documented_keys()

    assert not missing, f"undocumented settings: {sorted(missing)}"


def test_the_example_parses_and_agrees_with_the_code_defaults(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The example must parse *and* agree with the real defaults.

    Loading the file through ``Settings`` itself checks the values, their types
    and their syntax at once. String-comparing the file would miss a wrong type
    or an unquoted value that only fails at startup.

    ``_env_file=None`` is load-bearing: a developer's local ``backend/.env`` is
    exactly the file this test must *not* read. Letting it in compares the
    example against one machine's overrides instead of the code defaults, so the
    test fails for anyone who set a port or a public base URL locally.
    """
    for name in list(os.environ):
        if name.startswith(ENV_PREFIX):
            monkeypatch.delenv(name, raising=False)

    from_example = Settings(_env_file=EXAMPLE)  # type: ignore[call-arg]
    defaults = Settings(_env_file=None)  # type: ignore[call-arg]

    mismatches = [
        f"{field}: example={getattr(from_example, field)!r} "
        f"code={getattr(defaults, field)!r}"
        for field in _documented_keys()
        if getattr(from_example, field) != getattr(defaults, field)
    ]

    assert not mismatches, "stale values in .env.example:\n" + "\n".join(mismatches)


def test_relative_paths_are_anchored_to_the_project_root(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``data/x.db`` must mean the same thing however it is supplied.

    Left to itself the value would resolve against the process working directory,
    so the same string would silently pick a different database depending on
    whether it came from a default, ``.env``, an environment variable, or a test.
    """
    expected = (BACKEND_DIR.parent / "data" / "tasks.db").resolve()

    assert Settings().database_file == expected

    monkeypatch.setenv(f"{ENV_PREFIX}DATABASE_FILE", "data/tasks.db")
    assert Settings().database_file == expected

    monkeypatch.setenv(f"{ENV_PREFIX}SCREENSHOTS_DIR", "data/screenshots")
    assert Settings().screenshots_dir == (BACKEND_DIR.parent / "data" / "screenshots").resolve()


def test_ruff_config_is_valid_toml() -> None:
    """A malformed config file fails at the worst possible moment."""
    tomllib.loads((BACKEND_DIR / "ruff.toml").read_text(encoding="utf-8-sig"))


# ------------------------------------------------------------------ frontend --

FRONTEND_DIR = BACKEND_DIR.parent / "frontend"
FRONTEND_EXAMPLE = FRONTEND_DIR / ".env.example"

_FRONTEND_ASSIGNMENT = re.compile(r"#?\s*(NEXT_PUBLIC_[A-Z0-9_]+)=")
_FRONTEND_CODE = (
    FRONTEND_DIR / "src" / "lib" / "config.ts",
    FRONTEND_DIR / "next.config.ts",
)


def test_every_frontend_variable_is_actually_read() -> None:
    """A documented frontend variable that nothing reads is a trap.

    Someone sets it, the app ignores it, and the setting silently does nothing.
    """
    source = "\n".join(
        path.read_text(encoding="utf-8-sig") for path in _FRONTEND_CODE if path.is_file()
    )

    unread = [
        key
        for key in _FRONTEND_ASSIGNMENT.findall(FRONTEND_EXAMPLE.read_text(encoding="utf-8-sig"))
        if key not in source
    ]

    assert not unread, f"documented but never read by the frontend: {unread}"


def test_every_frontend_variable_the_code_reads_is_documented() -> None:
    """The reverse direction, so a new setting cannot go undocumented."""
    source = "\n".join(
        path.read_text(encoding="utf-8-sig") for path in _FRONTEND_CODE if path.is_file()
    )
    documented = set(_FRONTEND_ASSIGNMENT.findall(FRONTEND_EXAMPLE.read_text(encoding="utf-8-sig")))

    undocumented = sorted(set(re.findall(r'"(NEXT_PUBLIC_[A-Z0-9_]+)"', source)) - documented)

    assert not undocumented, f"undocumented frontend variables: {undocumented}"
