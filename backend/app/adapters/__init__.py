"""Adapters for everything outside this process.

Each adapter is a thin, replaceable client:

============  =========================================================
Ollama        local reasoning and embeddings
OpenClaw      optional agent turns through the running gateway
TinyFish      optional web search / page extraction (off by default)
Browser       the native Playwright agent loop
============  =========================================================

None of them hold state beyond a connection pool, so a failure in one never
corrupts another, and :mod:`app.services.health_service` can probe them all
independently.
"""

from __future__ import annotations

from .base import (
    AdapterError,
    AdapterUnavailable,
    CommandTimeout,
    IntegrationHealth,
    IntegrationState,
    redact,
    run_command,
)
from .browser_adapter import ACTIONS, BrowserAdapter, BrowserRunResult
from .ollama_adapter import OllamaAdapter
from .openclaw_adapter import OpenClawAdapter
from .tinyfish_adapter import TinyFishAdapter

__all__ = [
    "ACTIONS",
    "AdapterError",
    "AdapterUnavailable",
    "BrowserAdapter",
    "BrowserRunResult",
    "CommandTimeout",
    "IntegrationHealth",
    "IntegrationState",
    "OllamaAdapter",
    "OpenClawAdapter",
    "TinyFishAdapter",
    "redact",
    "run_command",
]
