"""Controlled Chromium lifecycle.

Three rules this module enforces, because breaking any of them produces a
corrupted browser session rather than a clean error:

1. One browser process, one task at a time. A single Playwright browser is
   launched lazily and a task-level asyncio.Lock is held for the whole
   session. That guarantees the orchestrator's browser agent and any
   OpenClaw-driven navigation cannot control the same browser concurrently.
2. Nothing launches at import or during health checks.
   BrowserManager.probe only inspects the installed Playwright package and
   on-disk browser cache, so GET /health never spawns a process.
3. Every session cleans up. The session is an async context manager; the
   context and page are closed on exit including on cancellation and timeout,
   and the browser is stopped when the manager shuts down.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

from ..config import Settings

logger = logging.getLogger("agentwebeinh.browser")


class BrowserBusyError(RuntimeError):
    """The single shared browser could not be acquired within the wait budget.

    Raised instead of blocking forever so the caller can fail the task with an
    honest reason rather than leaving it apparently running forever.
    """


def _browser_cache_dir() -> Path:
    """Return Playwright's browser download cache for this platform."""
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        return (
            Path(local) / "ms-playwright"
            if local
            else Path.home() / "AppData/Local/ms-playwright"
        )
    if sys.platform == "darwin":
        return Path.home() / "Library/Caches/ms-playwright"
    return Path.home() / ".cache/ms-playwright"


MAX_ELEMENTS = 60
MAX_TEXT_CHARS = 6_000
MAX_HEADINGS = 20


@dataclass(frozen=True, slots=True)
class ElementRef:
    """A clickable/typable element as presented to the agent."""

    index: int
    selector: str
    tag: str
    role: str | None
    text: str

    def describe(self) -> str:
        role = f" role={self.role}" if self.role else ""
        label = f" {self.text!r}" if self.text else ""
        return f"[{self.index}] <{self.tag}{role}>{label}"


class BrowserUnavailable(RuntimeError):
    """Chromium or Playwright is not usable on this machine."""


class BrowserSession:
    """One page owned by one task."""

    def __init__(
        self,
        page: Any,
        context: Any,
        settings: Settings,
        task_id: str,
    ) -> None:
        self._page = page
        self._context = context
        self._settings = settings
        self.task_id = task_id
        self._closed = False

    # ------------------------------------------------------------- inspection --

    async def current(self) -> tuple[str | None, str | None]:
        try:
            url = self._page.url
        except Exception:  # noqa: BLE001
            return None, None

        title: str | None = None
        with contextlib.suppress(Exception):
            title = await self._page.title()

        return (url or None), title

    async def goto(
        self,
        url: str,
        *,
        wait_until: str = "domcontentloaded",
    ) -> None:
        await self._page.goto(
            url,
            wait_until=wait_until,
            timeout=self._settings.browser_navigation_timeout_ms,
        )

    async def text(self, limit: int = MAX_TEXT_CHARS) -> str:
        """Readable page text, whitespace-collapsed and truncated."""
        try:
            raw = await self._page.inner_text("body", timeout=5_000)
        except Exception:  # noqa: BLE001
            return ""

        collapsed = " ".join((raw or "").split())
        return collapsed[:limit]

    async def headings(self, limit: int = MAX_HEADINGS) -> list[str]:
        """Distinct ``h1``-``h3`` texts in document order.

        Flat page text runs a heading straight into the paragraph beneath it, so a
        model asked for "the main heading" answers with both. Returning the
        headings separately lets the observation state them unambiguously.
        """
        script = """
        (max) => {
          const out = [];
          for (const el of document.querySelectorAll('h1, h2, h3')) {
            const text = (el.innerText || '').replace(/\\s+/g, ' ').trim();
            if (!text) continue;
            if (out.some((entry) => entry.text === text)) continue;
            out.push({ level: Number(el.tagName.slice(1)), text: text.slice(0, 200) });
            if (out.length >= max) break;
          }
          return out;
        }
        """
        try:
            found = await self._page.evaluate(script, limit)
        except Exception:  # noqa: BLE001
            return []

        headings: list[str] = []
        for entry in found or []:
            if isinstance(entry, dict) and entry.get("text"):
                headings.append(f"h{entry.get('level', 1)}: {entry['text']}")
        return headings

    async def elements(self, limit: int = MAX_ELEMENTS) -> list[ElementRef]:
        """Enumerate interactive elements with stable generated selectors."""
        script = """
        (max) => {
          const out = [];
          const nodes = document.querySelectorAll(
            'a, button, input, select, textarea, [role="button"], [role="link"], [onclick]'
          );
          for (const el of nodes) {
            if (out.length >= max) break;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            if (!el.id) el.id = 'awe-' + Math.random().toString(36).slice(2, 10);
            const text = (el.innerText || el.value || el.getAttribute('aria-label') || '')
              .replace(/\\s+/g, ' ').trim().slice(0, 80);
            out.push({
              selector: '#' + CSS.escape(el.id),
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute('role'),
              text: text,
            });
          }
          return out;
        }
        """

        try:
            raw = await self._page.evaluate(script, limit)
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "element_scan_failed task_id=%s error=%s",
                self.task_id,
                exc,
            )
            return []

        refs: list[ElementRef] = []
        for index, entry in enumerate(raw or [], start=1):
            refs.append(
                ElementRef(
                    index=index,
                    selector=str(entry.get("selector", "")),
                    tag=str(entry.get("tag", "")),
                    role=entry.get("role"),
                    text=str(entry.get("text", "")),
                )
            )

        return refs

    # ----------------------------------------------------------------- actions --

    async def click(self, selector: str) -> None:
        await self._page.click(
            selector,
            timeout=self._settings.browser_navigation_timeout_ms,
        )

    async def fill(self, selector: str, value: str) -> None:
        await self._page.fill(
            selector,
            value,
            timeout=self._settings.browser_navigation_timeout_ms,
        )

    async def press(self, key: str) -> None:
        await self._page.keyboard.press(key)

    async def scroll(self, direction: str = "down") -> None:
        delta = 800 if direction == "down" else -800
        await self._page.mouse.wheel(0, delta)
        await asyncio.sleep(0.4)

    async def back(self) -> None:
        await self._page.go_back(
            timeout=self._settings.browser_navigation_timeout_ms
        )

    # ---------------------------------------------------------------- capture --

    async def screenshot(self) -> tuple[bytes, int | None, int | None]:
        """JPEG bytes for the current viewport, plus its dimensions."""
        data = await self._page.screenshot(
            type="jpeg",
            quality=self._settings.browser_frame_quality,
            timeout=15_000,
        )

        width = self._settings.browser_viewport_width
        height = self._settings.browser_viewport_height

        with contextlib.suppress(Exception):
            size = await self._page.evaluate(
                "() => ({ w: window.innerWidth, h: window.innerHeight })"
            )
            if isinstance(size, dict):
                width = int(size.get("w") or width)
                height = int(size.get("h") or height)

        return data, width, height

    async def close(self) -> None:
        if self._closed:
            return

        self._closed = True
        for name, target in (("context", self._context), ("page", self._page)):
            try:
                await target.close()
            except Exception as exc:  # noqa: BLE001
                logger.debug(
                    "browser_close_failed task_id=%s target=%s error=%s",
                    self.task_id,
                    name,
                    exc,
                )


class BrowserManager:
    """Owns the shared Playwright browser and hands out exclusive sessions."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._playwright: Any = None
        self._browser: Any = None
        self._start_lock = asyncio.Lock()
        self._exclusive = asyncio.Lock()
        self._active: dict[str, BrowserSession] = {}
        self._launched = False

    # ------------------------------------------------------------------ health --

    def probe(self) -> dict[str, Any]:
        """Report what is installed without launching anything."""
        playwright_available = False
        playwright_version: str | None = None

        # Playwright does not reliably expose __version__ from its package
        # namespace. Read the installed distribution version instead.
        try:
            import playwright  # noqa: F401

            playwright_version = version("playwright")
            playwright_available = True
        except Exception as exc:  # noqa: BLE001
            logger.debug("playwright_probe_failed error=%s", exc)

        chromium_available = False
        chromium_path: Path | None = None
        cache = _browser_cache_dir()

        if cache.is_dir():
            for entry in sorted(cache.iterdir()):
                if entry.is_dir() and entry.name.startswith(
                    ("chromium-", "chromium_headless_shell-")
                ):
                    chromium_available = True
                    chromium_path = entry
                    break

        return {
            "playwright_available": playwright_available,
            "playwright_version": playwright_version,
            "chromium_available": chromium_available,
            "chromium_path": str(chromium_path) if chromium_path else None,
            "launched": self._launched,
            "active_sessions": len(self._active),
        }

    @property
    def active_session_count(self) -> int:
        return len(self._active)

    def active_task_ids(self) -> list[str]:
        return sorted(self._active)

    # --------------------------------------------------------------- lifecycle --

    async def _ensure_browser(self) -> Any:
        async with self._start_lock:
            if self._browser is not None:
                return self._browser

            if not self._settings.browser_enabled:
                raise BrowserUnavailable(
                    "Browser automation is disabled (AWE_BROWSER_ENABLED=false)."
                )

            probe = self.probe()

            if not probe["playwright_available"]:
                raise BrowserUnavailable(
                    "Playwright is not installed in this environment."
                )

            if not probe["chromium_available"]:
                raise BrowserUnavailable(
                    "No Playwright Chromium build was found. Run "
                    "`python -m playwright install chromium` inside backend\\.venv."
                )

            try:
                from playwright.async_api import async_playwright
            except ImportError as exc:  # pragma: no cover
                raise BrowserUnavailable(
                    "Playwright could not be imported."
                ) from exc

            self._playwright = await async_playwright().start()

            try:
                self._browser = await self._playwright.chromium.launch(
                    headless=self._settings.browser_headless,
                    slow_mo=self._settings.browser_slow_mo_ms,
                    args=["--disable-dev-shm-usage", "--no-sandbox"],
                )
            except Exception as exc:
                await self._stop_playwright()
                raise BrowserUnavailable(
                    f"Chromium failed to launch: {exc}"
                ) from exc

            self._launched = True
            logger.info(
                "browser_launched engine=%s",
                self._settings.browser_engine,
            )
            return self._browser

    async def _stop_playwright(self) -> None:
        if self._playwright is not None:
            with contextlib.suppress(Exception):
                await self._playwright.stop()
            self._playwright = None

    @contextlib.asynccontextmanager
    async def session(self, task_id: str) -> AsyncIterator[BrowserSession]:
        """Yield an exclusive browser session, guaranteed to be cleaned up.

        The wait for the shared browser is bounded. An unbounded wait produced a
        task that reported itself as running with no progress and no failure long
        after anyone would believe it was still working.
        """
        try:
            await asyncio.wait_for(
                self._exclusive.acquire(),
                timeout=self._settings.browser_session_wait_seconds,
            )
        except TimeoutError:
            holder = next(iter(self._active), "another task")
            logger.warning("browser_session_wait_timed_out task_id=%s holder=%s", task_id, holder)
            raise BrowserBusyError(
                f"The browser was still busy with {holder} after "
                f"{self._settings.browser_session_wait_seconds}s."
            ) from None

        browser: Any = None
        context: Any = None
        session: BrowserSession | None = None

        try:
            browser = await self._ensure_browser()
            context = await browser.new_context(
                viewport={
                    "width": self._settings.browser_viewport_width,
                    "height": self._settings.browser_viewport_height,
                },
                user_agent=self._settings.browser_user_agent,
                ignore_https_errors=False,
            )
            context.set_default_timeout(
                self._settings.browser_navigation_timeout_ms
            )
            page = await context.new_page()

            session = BrowserSession(
                page,
                context,
                self._settings,
                task_id,
            )
            self._active[task_id] = session
            yield session

        finally:
            if session is not None:
                await session.close()
                self._active.pop(task_id, None)
            elif context is not None:
                with contextlib.suppress(Exception):
                    await context.close()

            self._exclusive.release()

    async def stop(self) -> None:
        """Close every session and stop the browser. Safe to call twice."""
        for task_id, session in list(self._active.items()):
            await session.close()
            self._active.pop(task_id, None)

        if self._browser is not None:
            with contextlib.suppress(Exception):
                await self._browser.close()
            self._browser = None

        await self._stop_playwright()
        self._launched = False
        logger.info("browser_stopped")


__all__ = [
    "MAX_ELEMENTS",
    "MAX_TEXT_CHARS",
    "BrowserBusyError",
    "BrowserManager",
    "BrowserSession",
    "BrowserUnavailable",
    "ElementRef",
]