"""In-memory browser frame store and MJPEG fan-out.

Only the **latest** frame per task is retained. Frames are a live view, not a
recording: keeping history would grow without bound for a long-running task, and
the frontend only ever asks for "now".

Delivery to each connected MJPEG client uses a size-1 queue so a slow client
simply coalesces to the newest frame instead of accumulating a backlog.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass

from ..config import Settings
from ..utils.time import now_iso

logger = logging.getLogger("agentwebeinh.frames")

#: Multipart boundary for the ``multipart/x-mixed-replace`` MJPEG stream.
MJPEG_BOUNDARY = "aweframe"


@dataclass(frozen=True, slots=True)
class Frame:
    """One captured JPEG plus the page it was captured on."""

    data: bytes
    captured_at: str
    url: str | None = None
    title: str | None = None
    width: int | None = None
    height: int | None = None

    @property
    def byte_size(self) -> int:
        return len(self.data)


class FrameManager:
    """Stores the newest frame per task and streams it to MJPEG clients."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._latest: dict[str, Frame] = {}
        # task_id -> every live MJPEG consumer. A set, not a single queue: a
        # second browser tab must not silently starve the first one.
        self._subscribers: dict[str, set[asyncio.Queue[Frame]]] = {}
        self._lock = asyncio.Lock()
        self._published = 0
        self._dropped = 0

    # -------------------------------------------------------------- publishing --

    async def publish(
        self,
        task_id: str,
        data: bytes,
        *,
        url: str | None = None,
        title: str | None = None,
        width: int | None = None,
        height: int | None = None,
    ) -> Frame | None:
        """Record a new frame and wake every client streaming this task.

        Oversized payloads are rejected rather than truncated: a corrupt JPEG
        would make the frontend's ``<img>`` raise ``onError`` and the UI would
        claim the stream stopped.
        """
        if not data:
            return None
        if len(data) > self._settings.browser_max_screenshot_bytes:
            logger.warning(
                "frame_rejected_too_large task_id=%s bytes=%s",
                task_id,
                len(data),
            )
            return None

        frame = Frame(
            data=data,
            captured_at=now_iso(),
            url=url,
            title=title,
            width=width,
            height=height,
        )
        async with self._lock:
            self._latest[task_id] = frame
            self._published += 1
            for queue in tuple(self._subscribers.get(task_id, ())):
                try:
                    queue.put_nowait(frame)
                except asyncio.QueueFull:
                    # A client is behind; replace its pending frame with this one.
                    with contextlib.suppress(asyncio.QueueEmpty):
                        queue.get_nowait()
                        self._dropped += 1
                    with contextlib.suppress(asyncio.QueueFull):
                        queue.put_nowait(frame)
        return frame

    # -------------------------------------------------------------- retrieval --

    async def latest(self, task_id: str) -> Frame | None:
        async with self._lock:
            return self._latest.get(task_id)

    @property
    def ready(self) -> bool:
        """The frame service is usable as soon as the object exists."""
        return True

    def active_task_ids(self) -> list[str]:
        return sorted(self._latest)

    def stats(self) -> dict[str, int]:
        return {
            "tasks_with_frames": len(self._latest),
            "published": self._published,
            "dropped_for_slow_clients": self._dropped,
            "active_subscribers": sum(len(q) for q in self._subscribers.values()),
        }

    async def clear(self, task_id: str) -> None:
        async with self._lock:
            self._latest.pop(task_id, None)
            self._subscribers.pop(task_id, None)

    async def clear_all(self) -> None:
        async with self._lock:
            self._latest.clear()
            self._subscribers.clear()

    # --------------------------------------------------------------- streaming --

    def _idle_timeout(self) -> float:
        """How long a stream waits for a frame before giving up.

        Generous relative to the capture interval so a momentarily slow page does
        not tear down the view; when it does expire the frontend shows its
        explicit "the frame stream stopped delivering images" state.
        """
        return max(15.0, (self._settings.browser_frame_interval_ms / 1000.0) * 8)

    async def mjpeg_stream(self, task_id: str) -> AsyncIterator[bytes]:
        """Yield ``multipart/x-mixed-replace`` chunks for one task.

        The current frame is replayed immediately on connect so a client that
        attaches mid-run sees something straight away.
        """
        queue: asyncio.Queue[Frame] = asyncio.Queue(maxsize=1)
        async with self._lock:
            existing = self._latest.get(task_id)
            if existing is not None:
                queue.put_nowait(existing)
            self._subscribers.setdefault(task_id, set()).add(queue)

        logger.info("mjpeg_stream_opened task_id=%s", task_id)
        idle = self._idle_timeout()
        try:
            while True:
                try:
                    frame = await asyncio.wait_for(queue.get(), timeout=idle)
                except TimeoutError:
                    logger.info("mjpeg_stream_idle_timeout task_id=%s", task_id)
                    return
                yield _mjpeg_part(frame, MJPEG_BOUNDARY)
        finally:
            async with self._lock:
                listeners = self._subscribers.get(task_id)
                if listeners is not None:
                    listeners.discard(queue)
                    if not listeners:
                        self._subscribers.pop(task_id, None)
            logger.info("mjpeg_stream_closed task_id=%s", task_id)


def _mjpeg_part(frame: Frame, boundary: str) -> bytes:
    """Encode one JPEG as a multipart part."""
    header = (
        f"--{boundary}\r\n"
        f"Content-Type: image/jpeg\r\n"
        f"Content-Length: {frame.byte_size}\r\n"
        f"X-Captured-At: {frame.captured_at}\r\n"
        f"\r\n"
    ).encode("ascii")
    return header + frame.data + b"\r\n"


__all__ = ["MJPEG_BOUNDARY", "Frame", "FrameManager"]
