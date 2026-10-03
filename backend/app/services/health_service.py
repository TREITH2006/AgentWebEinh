"""Health and status reporting.

The single most important rule: **an optional integration being down must not make
the backend look unhealthy.** The frontend treats a 2xx from ``GET /health`` as
"live mode is available", so if a missing Ollama could flip ``healthy`` to false,
the whole UI would silently fall back to demo data.

``healthy`` therefore depends only on the two things that are genuinely
required: the database answers a query, and the worker pool is running.
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

#: Total budget for the whole status response. Probes run concurrently.
PROBE_BUDGET_SECONDS = 5.0

_APP_VERSION = "1.0.0"


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
    ) -> None:
        self._settings = settings
        self._database = database
        self._task_manager = task_manager
        self._ollama = ollama
        self._openclaw = openclaw
        self._browser = browser
        self._tinyfish = tinyfish
        self._frames = frames
        self._started_monotonic = time.monotonic()

    @property
    def uptime_seconds(self) -> float:
        return round(time.monotonic() - self._started_monotonic, 3)

    async def snapshot(self) -> StatusResponse:
        """Probe everything concurrently under one deadline."""
        database_component, probe_results = await asyncio.gather(
            self._probe_database(),
            self._probe_integrations(),
        )

        components: dict[str, ComponentStatusDto] = {
            "database": database_component,
            "task_manager": self._task_manager_component(),
        }
        notes: list[str] = []

        ollama_health, openclaw_health, browser_health, tinyfish_health = probe_results
        for health in (ollama_health, openclaw_health, browser_health, tinyfish_health):
            if health is None:
                continue
            components[health.name] = ComponentStatusDto(
                state=health.state, detail=health.detail
            )
            if health.state == "down":
                notes.append(f"{health.name}: {health.detail}")

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

    async def _probe_integrations(
        self,
    ) -> tuple[IntegrationHealth | None, ...]:
        """Probe the optional integrations in parallel, with a hard budget.

        A probe that overruns the budget returns ``None`` rather than delaying the
        whole response: health must stay fast even when a dependency hangs.
        """

        async def with_budget(coro: Any, label: str) -> IntegrationHealth | None:
            try:
                return await asyncio.wait_for(coro, timeout=PROBE_BUDGET_SECONDS)
            except TimeoutError:
                logger.info("health_probe_timed_out name=%s", label)
                return IntegrationHealth(
                    label, "degraded", f"No response within {PROBE_BUDGET_SECONDS:.0f}s."
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("health_probe_failed name=%s error=%s", label, type(exc).__name__)
                return IntegrationHealth(label, "down", f"The probe failed ({type(exc).__name__}).")

        browser_health = self._browser_adapter_health()
        return tuple(
            await asyncio.gather(
                with_budget(self._ollama.health(), "ollama"),
                with_budget(self._openclaw.health(), "openclaw"),
                with_budget(_immediate(browser_health), "browser"),
                with_budget(self._tinyfish.health(), "tinyfish"),
            )
        )

    def _browser_adapter_health(self) -> IntegrationHealth:
        """Ask the browser adapter so the reported engine matches the configured one."""
        from ..adapters.browser_adapter import BrowserAdapter  # local: avoids a cycle

        adapter = BrowserAdapter(self._settings, self._browser, self._ollama)
        return adapter.health()


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
