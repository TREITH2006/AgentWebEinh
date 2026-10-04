"""Typed browser events, so the orchestrator reads as intent rather than plumbing.

Every helper here does three things in the right order: update the task snapshot,
then publish the event (which carries that snapshot), and — where relevant —
record the frame. Keeping that order in one place is what stops the WebSocket
from ever showing an event whose ``task.status`` disagrees with the event type.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ..schemas.event import EventType

if TYPE_CHECKING:  # pragma: no cover - typing only, avoids an import cycle
    from ..browser.frame_manager import FrameManager
    from ..core.task_manager import TaskContext

logger = logging.getLogger("agentwebeinh.browser_events")


class BrowserEventEmitter:
    """Translates browser actions into events and snapshot updates."""

    def __init__(self, context: TaskContext, frames: FrameManager) -> None:
        self._ctx = context
        self._frames = frames

    async def log(self, message: str, *, detail: str | None = None) -> None:
        await self._ctx.emit(EventType.LOG, message, detail=detail)

    async def progress(self, activity: str, progress: float) -> None:
        """Advance the task's visible progress.

        The snapshot is patched without an event on purpose: this fires once per
        agent step, and an event per step would bury the events that actually
        describe what the agent did. The running snapshot the frontend already
        receives carries the new values, so the UI still moves.
        """
        await self._ctx.update(current_activity=activity[:200], progress=progress)

    async def opened(self, url: str | None, title: str | None) -> None:
        await self._ctx.update(current_url=url, current_title=title)
        await self._ctx.emit(EventType.BROWSER_OPENED, f"Opened {title or url or 'page'}",
                             url=url, detail=title)

    async def navigated(self, url: str | None, title: str | None) -> None:
        await self._ctx.update(current_url=url, current_title=title)
        await self._ctx.emit(EventType.PAGE_NAVIGATED, f"Navigated to {title or url or 'page'}",
                             url=url, detail=title)

    async def back(self, url: str | None, title: str | None) -> None:
        await self._ctx.update(current_url=url, current_title=title)
        await self._ctx.emit(EventType.ACTION_PERFORMED, "Went back to the previous page",
                             url=url, detail=title)

    async def action(self, label: str, target: str | None, *, url: str | None = None,
                     detail: str | None = None) -> None:
        """A discrete interaction: click, type, scroll, select, extract, screenshot."""
        await self._ctx.update(current_url=url)
        await self._ctx.emit(EventType.ACTION_PERFORMED, label, url=url, detail=detail,
                             data={"target": target} if target else None)

    async def inspected(self, target: str, detail: str | None = None) -> None:
        await self._ctx.emit(EventType.ELEMENT_INSPECTED, f"Inspected {target}", detail=detail)

    async def collected(self, label: str, value: str, *, url: str | None = None) -> None:
        """A finding extracted from the page."""
        await self._ctx.update(current_url=url)
        await self._ctx.emit(
            EventType.INFORMATION_COLLECTED, f"Collected {label}",
            url=url, detail=f"{label}: {value}",
            data={"label": label, "value": value},
        )

    async def frame(self, url: str | None, title: str | None, byte_size: int) -> None:
        """Announce a captured frame *without* an event.

        A frame arrives every ~1.2s; turning each into an event would flood the
        history endpoint and the event log. The snapshot fields carry the state
        instead, and the frame URL is stable, so the frontend learns about it
        through polling and the WebSocket stays readable.
        """
        await self._ctx.note_frame(url, title, byte_size)

    async def publish_frame(self, data: bytes, url: str | None, title: str | None,
                            width: int | None, height: int | None) -> None:
        """Capture path used by the agent loop: store the frame and record it."""
        frame = await self._frames.publish(
            self._ctx.task_id, data, url=url, title=title, width=width, height=height
        )
        if frame is not None:
            await self.frame(frame.url, frame.title, frame.byte_size)


__all__ = ["BrowserEventEmitter"]
