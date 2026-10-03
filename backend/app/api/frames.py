"""Browser frame endpoints: discovery, snapshot, and the MJPEG stream.

Caching is the load-bearing detail here. The frontend polls ``frame.jpg`` roughly
every 1.2 seconds and separately declares a view stale after five seconds. If a
snapshot were ever cached, the browser would keep showing a stale frame with a
fresh-looking timestamp and the staleness warning could never fire — so every
frame response is explicitly ``no-store``.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Response, status
from fastapi.responses import StreamingResponse

from ..errors import task_not_found
from ..schemas.task import TaskFramesDto
from .deps import FrameManagerDep, SettingsDep, TaskServiceDep

logger = logging.getLogger("agentwebeinh.api.frames")

router = APIRouter(prefix="/api/tasks", tags=["frames"])

#: Frame responses must never be cached, by any layer.
NO_STORE = "no-store, no-cache, must-revalidate, max-age=0"
PRAGMA_NO_CACHE = "no-cache"


@router.get("/{task_id}/frames", response_model=TaskFramesDto, summary="Frame URLs")
async def frame_urls(
    task_id: str,
    tasks: TaskServiceDep,
    frames: FrameManagerDep,
    settings: SettingsDep,
) -> TaskFramesDto:
    """Absolute URLs for the task's live view.

    Both URLs are always present, even before the first frame is captured: the
    stream endpoint holds the connection open and delivers frames as soon as they
    exist, which is better than a URL that appears and disappears.
    """
    task = await tasks.get_task(task_id)
    if task is None:
        raise task_not_found(task_id)

    frame = await frames.latest(task_id)
    return TaskFramesDto(
        task_id=task_id,
        frames_url=settings.frames_stream_url(task_id),
        snapshot_url=settings.snapshot_url(task_id),
        captured_at=frame.captured_at if frame else None,
        width=frame.width if frame else None,
        height=frame.height if frame else None,
        engine=settings.browser_engine,
    )


@router.get("/{task_id}/frame.jpg", summary="Latest JPEG snapshot")
async def snapshot(
    task_id: str,
    tasks: TaskServiceDep,
    frames: FrameManagerDep,
) -> Response:
    """The most recent frame as ``image/jpeg``.

    ``404`` when the task exists but has produced no frame, so the frontend can
    distinguish "not started yet" from "the stream died".
    """
    task = await tasks.get_task(task_id)
    if task is None:
        raise task_not_found(task_id)

    frame = await frames.latest(task_id)
    if frame is None:
        return Response(
            status_code=status.HTTP_404_NOT_FOUND,
            content=b"No frame has been captured for this task yet.",
            media_type="text/plain; charset=utf-8",
            headers={"Cache-Control": NO_STORE, "Pragma": PRAGMA_NO_CACHE},
        )

    return Response(
        content=frame.data,
        media_type="image/jpeg",
        headers={
            "Cache-Control": NO_STORE,
            "Pragma": PRAGMA_NO_CACHE,
            "X-Captured-At": frame.captured_at,
            "X-Frame-Url": (frame.url or "")[:2_000],
        },
    )


@router.get("/{task_id}/stream.mjpeg", summary="Live MJPEG stream")
async def mjpeg_stream(
    task_id: str,
    tasks: TaskServiceDep,
    frames: FrameManagerDep,
) -> StreamingResponse:
    """``multipart/x-mixed-replace`` stream of frames as they are captured.

    Falls back to a long-poll wait when the browser is not producing frames yet, so
    an ``<img>`` pointed here stays valid for the whole run.
    """
    task = await tasks.get_task(task_id)
    if task is None:
        raise task_not_found(task_id)

    return StreamingResponse(
        frames.mjpeg_stream(task_id),
        media_type="multipart/x-mixed-replace; boundary=aweframe",
        headers={
            "Cache-Control": NO_STORE,
            "Pragma": PRAGMA_NO_CACHE,
            "Connection": "close",
            "X-Accel-Buffering": "no",
        },
    )


__all__ = ["NO_STORE", "PRAGMA_NO_CACHE", "router"]
