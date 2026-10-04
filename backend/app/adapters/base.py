"""Adapter foundation: health reporting, timeouts, and output redaction.

Every adapter talks to something outside this process — a subprocess, an HTTP
service, a CLI — and each of those can hang, print secrets, or disappear
mid-run. The shared base class handles those three concerns so individual
adapters only describe *what* they do.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger("agentwebeinh.adapters")

#: Overall health is only ever ``ok`` / ``degraded``; a failing *optional*
#: integration must not make the whole backend look unhealthy.
IntegrationState = Literal["up", "degraded", "down", "disabled"]


@dataclass(frozen=True, slots=True)
class IntegrationHealth:
    """Result of a single integration's readiness probe."""

    name: str
    state: IntegrationState
    detail: str
    #: Extra structured context (versions, model names, paths). Never secrets.
    info: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.state in ("up", "disabled")


class AdapterError(RuntimeError):
    """Adapter failed in a way the orchestrator can explain to the user."""

    def __init__(self, message: str, *, code: str = "adapter_error", retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class AdapterUnavailable(AdapterError):
    """The integration is not configured or not installed on this machine."""

    def __init__(self, message: str, *, code: str = "adapter_unavailable") -> None:
        super().__init__(message, code=code, retryable=True)


class CommandTimeout(AdapterError):
    """An external command exceeded its deadline and was terminated."""

    def __init__(self, message: str, *, timeout: float) -> None:
        super().__init__(message, code="adapter_timeout", retryable=True)
        self.timeout = timeout


#: Patterns scrubbed from adapter output before it reaches a log or an event.
_SECRET_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Authorization / bearer headers.
    (re.compile(r"(?i)\b(bearer|token|api[_-]?key|apikey|secret|password|passwd)\b\s*[:=]\s*\S+"),
     r"\1=<redacted>"),
    # Provider-style key literals.
    (re.compile(r"\b(sk|pk|ghp|gho|xoxb|xoxp|tf)-[A-Za-z0-9_-]{12,}\b"), "<redacted>"),
    # Credentials embedded in URLs.
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]+:[^/\s@]+@"), r"\1<redacted>@"),
)


def redact(text: str, *, limit: int = 2_000) -> str:
    """Strip credential-shaped substrings and bound the length.

    Webpages, model output and CLI logs are all untrusted text that ends up in
    logs and event details. Scrubbing here means no adapter can forget to.
    """
    if not text:
        return ""
    scrubbed = text
    for pattern, replacement in _SECRET_PATTERNS:
        scrubbed = pattern.sub(replacement, scrubbed)
    scrubbed = scrubbed.replace("\x00", "")
    if len(scrubbed) > limit:
        scrubbed = scrubbed[:limit] + f"... [truncated {len(scrubbed) - limit} chars]"
    return scrubbed


def _windows_batch_argv(argv: list[str]) -> list[str] | None:
    """Wrap ``argv`` in ``cmd.exe`` when the target is a Windows batch script.

    npm installs CLIs as ``<name>.CMD`` shims, and ``CreateProcess`` cannot
    execute a batch file directly — ``asyncio.create_subprocess_exec`` raises
    ``FileNotFoundError`` for it even though ``shutil.which`` resolves it, which
    is why ``openclaw`` reported "Command not found" while ``cli_available`` was
    true. ``cmd.exe`` is the only supported way to run one.

    Returns ``None`` when ``argv[0]`` is a real executable, so the shell-free
    guarantee still holds everywhere else: ``cmd.exe`` is only ever handed the
    resolved script path plus arguments escaped by ``list2cmdline``, never
    concatenated model- or page-derived text.
    """
    if os.name != "nt" or not argv:
        return None

    resolved = shutil.which(argv[0])
    if not resolved:
        return None

    if not resolved.lower().endswith((".cmd", ".bat")):
        return None

    command_line = subprocess.list2cmdline([resolved, *argv[1:]])
    return ["cmd.exe", "/d", "/s", "/c", command_line]


async def run_command(
    argv: list[str],
    *,
    timeout: float,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> tuple[int, str, str]:
    """Run a subprocess with a hard deadline and captured output.

    Never uses a shell, so model- or page-derived text can never be interpreted
    as a command. On Windows a ``.cmd``/``.bat`` shim is the single exception,
    since the OS cannot start one any other way — see :func:`_windows_batch_argv`.
    On timeout the whole process tree is killed rather than left running in the
    background.
    """
    logger.debug("adapter_command argv=%s", argv[:1])
    spawn_argv = _windows_batch_argv(argv) or argv
    try:
        process = await asyncio.create_subprocess_exec(
            *spawn_argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
        )
    except FileNotFoundError as exc:
        raise AdapterUnavailable(f"Command not found: {argv[0]}") from exc
    except OSError as exc:
        raise AdapterUnavailable(f"Could not start {argv[0]}: {exc}") from exc

    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        with contextlib.suppress(Exception):
            process.kill()
        with contextlib.suppress(Exception):
            await asyncio.wait_for(process.wait(), timeout=5)
        raise CommandTimeout(f"{argv[0]} exceeded {timeout:.0f}s", timeout=timeout) from None

    return (
        process.returncode if process.returncode is not None else -1,
        stdout.decode("utf-8", "replace"),
        stderr.decode("utf-8", "replace"),
    )


__all__ = [
    "AdapterError",
    "AdapterUnavailable",
    "CommandTimeout",
    "IntegrationHealth",
    "IntegrationState",
    "redact",
    "run_command",
]
