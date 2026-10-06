"""Health and status reporting.

The single most important rule: **an optional integration being down must not make
the backend look unhealthy.** The frontend treats a 2xx from ``GET /health`` as
"live mode is available", so if a missing Ollama could flip ``healthy`` to false,
the whole UI would silently fall back to demo data.

``healthy`` therefore depends only on the two things that are genuinely
required: the database answers a query, and the worker pool is running.

Two further rules exist because a status document that lies is worse than no
status document at all:

* **Never report a healthy dependency as down because of our own deadline.** Each
  probe gets its configured budget; a shared cap that overrode every adapter made
  a working OpenClaw gateway report ``degraded`` on every request.
* **Never let a slow dependency make the endpoint slow.** Probe results are cached
  for :attr:`~app.config.Settings.status_cache_seconds`, so ``/api/status`` -- the
  endpoint the frontend probes to decide it is talking to the real backend --
  answers in milliseconds instead of paying the slowest CLI's start-up cost.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from ..adapters.base import IntegrationHealth
from ..browser.browser_manager import BrowserManager
from ..config import Settings
from ..database.database import Database
from ..schemas.stats import (
    BrowserStatusDto,
    ComponentStatusDto,
    OllamaStatusDto,
    OpenClawStatusDto,
    StatusResponse,
    TinyFishStatusDto,
)
from ..utils.time import now_iso

logger = logging.getLogger("agentwebeinh.health")

#: Floor for any single integration probe. Keeps a pathological timeout from
#: stalling the status response when nothing has configured a tighter budget.
PROBE_BUDGET_SECONDS = 5.0

#: Slack added on top of an adapter's own budget so the probe's real deadline
#: fires first and reports its own, more specific, error.
PROBE_GRACE_SECONDS = 2.0

#: Backwards-compatible alias for the grace period.
_PROBE_MARGIN_SECONDS = PROBE_GRACE_SECONDS

_APP_VERSION = "1.0.0"


class _IntegrationSnapshot:
    """The integration probe outcome, cached between ``/api/status`` calls."""

    __slots__ = ("browser", "expires_at", "ollama", "openclaw", "tinyfish")

    def __init__(
        self,
        ollama: IntegrationHealth | None,
        openclaw: IntegrationHealth | None,
        browser: IntegrationHealth | None,
        tinyfish: IntegrationHealth | None,
        expires_at: float,
    ) -> None:
        self.ollama = ollama
        self.openclaw = openclaw
        self.browser = browser
        self.tinyfish = tinyfish
        self.expires_at = expires_at


class HealthService:
    """Builds ``GET /health`` and ``GET /api/status`` payloads."""

    def __init__(
        self,
        *,
        settings: Settings,
        database: Database,
        task_manager: Any,
        ollama: Any,
        openclaw: Any,
        browser: BrowserManager,
        tinyfish: Any,
        frames: Any,
        extension_bridge: Any = None,
    ) -> None:
        self._settings = settings
        self._database = database
        self._task_manager = task_manager
        self._ollama = ollama
        self._openclaw = openclaw
        self._browser = browser
        self._tinyfish = tinyfish
        self._frames = frames
        self._extension_bridge = extension_bridge
        self._started_monotonic = time.monotonic()
        self._cache: _IntegrationSnapshot | None = None
        self._probe_lock = asyncio.Lock()

    @property
    def uptime_seconds(self) -> float:
        return round(time.monotonic() - self._started_monotonic, 3)

    async def snapshot(self) -> StatusResponse:
        """Build the status document, reusing a recent probe where possible."""
        database_component, integrations = await asyncio.gather(
            self._probe_database(),
            self._integration_snapshot(),
        )

        components: dict[str, ComponentStatusDto] = {
            "database": database_component,
            "task_manager": self._task_manager_component(),
        }
        notes: list[str] = []

        ollama_health = integrations.ollama
        openclaw_health = integrations.openclaw
        browser_health = integrations.browser
        tinyfish_health = integrations.tinyfish

        for health in (ollama_health, openclaw_health, browser_health, tinyfish_health):
            if health is None:
                continue
            components[health.name] = ComponentStatusDto(
                state=health.state, detail=health.detail
            )
            if health.state == "down":
                notes.append(f"{health.name}: {health.detail}")

        extension_component = self._extension_component()
        if extension_component is not None:
            components[extension_component[0]] = extension_component[1]

        database_ok = database_component.state == "up"
        workers_ok = components["task_manager"].state == "up"
        healthy = database_ok and workers_ok

        if not database_ok:
            status: str = "unhealthy"
        elif healthy and not notes:
            status = "healthy"
        else:
            status = "degraded"

        return StatusResponse(
            status=status,
            healthy=healthy,
            version=_APP_VERSION,
            environment=self._settings.environment,
            server_time=now_iso(),
            uptime_seconds=self.uptime_seconds,
            public_base_url=self._settings.public_base_url,
            components=components,
            openclaw=_openclaw_dto(openclaw_health, self._settings),
            ollama=_ollama_dto(ollama_health, self._settings),
            browser=_browser_dto(browser_health, self._browser, self._settings),
            tinyfish=_tinyfish_dto(tinyfish_health),
            notes=notes,
        )

    # ----------------------------------------------------------------- probes --

    async def _probe_database(self) -> ComponentStatusDto:
        started = time.monotonic()
        try:
            healthy = await self._database.ping()
        except Exception as exc:  # noqa: BLE001 - any failure is the same signal
            logger.warning("health_database_failed error=%s", type(exc).__name__)
            return ComponentStatusDto(
                state="down", detail="The task database is not reachable."
            )
        latency = int((time.monotonic() - started) * 1000)
        return ComponentStatusDto(
            state="up" if healthy else "down",
            detail="Task database is reachable." if healthy else "The task database did not answer.",
            latency_ms=latency,
        )

    def _task_manager_component(self) -> ComponentStatusDto:
        ready = bool(getattr(self._task_manager, "ready", False))
        return ComponentStatusDto(
            state="up" if ready else "down",
            detail=(
                f"Worker pool accepting work "
                f"({self._task_manager.inflight_count} running, "
                f"{self._task_manager.queued_count} queued)."
                if ready
                else "The worker pool is not accepting work."
            ),
        )

    async def _integration_snapshot(self) -> _IntegrationSnapshot:
        """Cached integration probes, re-run only once they have gone stale.

        The frontend probes ``/api/status`` on every page load to decide whether it
        is talking to the real backend, and one of those probes is a subprocess
        that needs seconds to start on Windows. Without a cache every page load
        paid that cost, overran the client's deadline, and reported a working
        backend as unreachable -- which is exactly the failure the identity probe
        exists to prevent.

        The lock makes a burst of concurrent callers share one probe instead of
        each spawning its own copy of the same subprocesses.
        """
        cached = self._cache
        if cached is not None and time.monotonic() < cached.expires_at:
            return cached

        async with self._probe_lock:
            # A caller that queued behind another may find the cache already fresh.
            cached = self._cache
            if cached is not None and time.monotonic() < cached.expires_at:
                return cached

            ollama, openclaw, browser, tinyfish = await self._probe_integrations()
            ttl = max(self._settings.status_cache_seconds, 0.0)
            snapshot = _IntegrationSnapshot(
                ollama, openclaw, browser, tinyfish, expires_at=time.monotonic() + ttl
            )
            self._cache = snapshot
            return snapshot

    async def _probe_integrations(
        self,
    ) -> tuple[IntegrationHealth | None, ...]:
        """Probe the optional integrations in parallel, with a hard budget.

        A probe that overruns its budget returns ``degraded`` rather than delaying
        the whole response: health must stay fast even when a dependency hangs.
        """

        async def with_budget(
            coro: Any, label: str, budget: float = PROBE_BUDGET_SECONDS
        ) -> IntegrationHealth | None:
            try:
                return await asyncio.wait_for(coro, timeout=budget)
            except TimeoutError:
                logger.info("health_probe_timed_out name=%s budget=%s", label, budget)
                return IntegrationHealth(
                    label,
                    "degraded",
                    f"No response within {budget:.0f}s. That is this service's "
                    f"deadline for the check, not a verdict on the integration.",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("health_probe_failed name=%s error=%s", label, type(exc).__name__)
                return IntegrationHealth(label, "down", f"The probe failed ({type(exc).__name__}).")

        browser_health = self._browser_adapter_health()
        return tuple(
            await asyncio.gather(
                with_budget(
                    self._ollama.health(),
                    "ollama",
                    self._probe_budget(self._settings.ollama_health_timeout_seconds),
                ),
                with_budget(
                    self._openclaw.health(),
                    "openclaw",
                    self._probe_budget(self._settings.openclaw_health_timeout_ms / 1000.0),
                ),
                with_budget(_immediate(browser_health), "browser"),
                with_budget(self._tinyfish.health(), "tinyfish"),
            )
        )

    def _probe_budget(self, configured_seconds: float) -> float:
        """Outer deadline for one probe, derived from the adapter's own budget.

        A single shared cap overrode every adapter with the same five seconds, which
        is shorter than the OpenClaw Node CLI takes merely to start on this PC. The
        result was a perfectly healthy gateway reported as ``degraded`` on every
        request while its own probe was still running. The floor keeps a
        too-tight configured timeout from producing the same false negative in the
        other direction, and the grace period makes the adapter's deadline -- which
        can name the command and its limit -- the one that actually fires.
        """
        return max(PROBE_BUDGET_SECONDS, configured_seconds + PROBE_GRACE_SECONDS)

    def _browser_adapter_health(self) -> IntegrationHealth:
        """Ask the browser adapter so the reported engine matches the configured one."""
        from ..adapters.browser_adapter import BrowserAdapter  # local: avoids a cycle

        adapter = BrowserAdapter(self._settings, self._browser, self._ollama)
        return adapter.health()

    def _extension_component(self) -> tuple[str, ComponentStatusDto] | None:
        """Report the extension bridge without letting it affect the overall status."""
        bridge = self._extension_bridge
        if bridge is None or not self._settings.browser_extension_enabled:
            return None
        health = bridge.health()
        component = ComponentStatusDto(
            state=health.state,
            detail=health.detail,
        )
        return health.name, component


# ------------------------------------------------------------------- mapping --


async def _immediate(value: Any) -> Any:
    return value


def _ollama_dto(health: IntegrationHealth | None, settings: Settings) -> OllamaStatusDto | None:
    if health is None:
        return None
    info = health.info
    return OllamaStatusDto(
        state=health.state,
        detail=health.detail,
        base_url=settings.ollama_url,
        model=settings.ollama_model,
        model_available=bool(info.get("chat_model_present", False)),
        embedding_model=settings.ollama_embedding_model,
        embedding_model_available=bool(info.get("embedding_model_present", False)),
    )


def _openclaw_dto(health: IntegrationHealth | None, settings: Settings) -> OpenClawStatusDto | None:
    if health is None:
        return None
    info = health.info
    plugins = info.get("plugins")
    return OpenClawStatusDto(
        state=health.state,
        detail=health.detail,
        gateway_url=settings.openclaw_gateway,
        gateway_reachable=health.state in ("up", "degraded"),
        cli_available=settings.openclaw_enabled,
        plugins=[str(item) for item in plugins] if isinstance(plugins, list) else [],
        version=str(info["version"]) if info.get("version") else None,
    )


def _browser_dto(
    health: IntegrationHealth | None, browser: BrowserManager, settings: Settings
) -> BrowserStatusDto | None:
    if health is None:
        return None
    info = health.info
    return BrowserStatusDto(
        state=health.state,
        detail=health.detail,
        engine=str(info.get("engine", settings.browser_engine)),
        playwright_available=bool(info.get("playwright_version")),
        chromium_available=bool(info.get("chromium_path")),
        active_sessions=browser.active_session_count,
    )


def _tinyfish_dto(health: IntegrationHealth | None) -> TinyFishStatusDto | None:
    if health is None:
        return None
    return TinyFishStatusDto(
        state=health.state,
        detail=health.detail,
        cli_available=health.state != "disabled",
        enabled=health.state != "disabled",
    )


__all__ = ["PROBE_BUDGET_SECONDS", "HealthService"]
