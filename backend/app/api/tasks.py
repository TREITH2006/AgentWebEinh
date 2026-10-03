"""``/api/tasks`` — submission, listing, detail and cancellation."""

from __future__ import annotations

import logging
from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from ..schemas.task import (
    CreateTaskRequest,
    CreateTaskResponse,
    TaskDto,
    TaskListResponse,
    TaskSort,
    TaskStatus,
)
from .deps import TaskManagerDep

logger = logging.getLogger("agentwebeinh.api.tasks")

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.post(
    "",
    response_model=CreateTaskResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Submit a task",
    responses={
        status.HTTP_200_OK: {
            "model": CreateTaskResponse,
            "description": "Idempotent replay of a previously accepted submission.",
        }
    },
)
async def create_task(
    payload: CreateTaskRequest,
    manager: TaskManagerDep,
    response: Response,
) -> CreateTaskResponse:
    """Queue a new task.

    Returns ``201`` with the task id and ``queued`` status immediately: execution
    happens in the background, so the frontend can navigate to the workspace
    without waiting for a browser or model to warm up.

    Repeating a ``clientRequestId`` returns the original task with ``200`` instead
    of starting a second run — the resource already exists, so ``200`` is the
    honest status.
    """
    dto, created = await manager.submit(
        payload.prompt, client_request_id=payload.client_request_id
    )
    if not created:
        response.status_code = status.HTTP_200_OK
        logger.info("task_submit_replayed task_id=%s", dto.id)
    return CreateTaskResponse(id=dto.id, status=dto.status, created_at=dto.created_at)


@router.get("", response_model=TaskListResponse, summary="List tasks")
async def list_tasks(
    manager: TaskManagerDep,
    search: Annotated[str | None, Query(max_length=200)] = None,
    task_status: Annotated[TaskStatus | None, Query(alias="status")] = None,
    sort: Annotated[TaskSort, Query()] = "newest",
    limit: Annotated[int | None, Query(ge=1, le=200)] = None,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> TaskListResponse:
    """Paginated task history, newest first by default."""
    result = await manager.list_tasks(
        search=search,
        status=task_status.value if task_status else None,
        sort=sort,
        limit=limit if limit is not None else 25,
        offset=offset,
    )
    return TaskListResponse.model_validate(result)


@router.get("/{task_id}", response_model=TaskDto, summary="Get one task")
async def get_task(task_id: str, manager: TaskManagerDep) -> TaskDto:
    """Full task object, including ``report`` once the task has settled."""
    return await manager.get_task(task_id)


@router.post(
    "/{task_id}/cancel",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Request cancellation",
    response_class=Response,
)
async def cancel_task(task_id: str, manager: TaskManagerDep) -> Response:
    """Ask the backend to stop a task cooperatively.

    ``202`` with an empty body: cancellation is a request, not a promise. The final
    ``cancelled`` status arrives through the event stream, so a client that
    assumed the task had already stopped here would be wrong.
    """
    await manager.cancel(task_id)
    return Response(status_code=status.HTTP_202_ACCEPTED)


__all__ = ["router"]
