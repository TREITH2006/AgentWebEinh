"""Error envelope and exception handlers.

Every JSON error the API produces has the shape the frontend expects::

    {"error": {"code": "task_not_found", "message": "No task with that id.",
               "fields": {"prompt": "Required."}}}

``src/lib/api/client.ts`` reads ``error.message``, ``error.code`` and
``error.fields``, and maps the HTTP status to a human sentence when the body has
no message. FastAPI's default ``{"detail": ...}`` body is also tolerated by the
frontend, but is never emitted here so the contract stays single-shaped.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("agentwebeinh.errors")

# Status codes are written as integers rather than Starlette constants because
# Starlette renamed 413/422 and the symbolic names now emit deprecation warnings.
HTTP_422_UNPROCESSABLE = 422

#: Default code per status, used when a handler does not supply one.
DEFAULT_CODES: dict[int, str] = {
    status.HTTP_400_BAD_REQUEST: "bad_request",
    status.HTTP_401_UNAUTHORIZED: "unauthorized",
    status.HTTP_403_FORBIDDEN: "forbidden",
    status.HTTP_404_NOT_FOUND: "not_found",
    status.HTTP_405_METHOD_NOT_ALLOWED: "method_not_allowed",
    status.HTTP_409_CONFLICT: "conflict",
    413: "payload_too_large",
    HTTP_422_UNPROCESSABLE: "validation_error",
    status.HTTP_429_TOO_MANY_REQUESTS: "rate_limited",
    status.HTTP_500_INTERNAL_SERVER_ERROR: "internal_error",
    status.HTTP_503_SERVICE_UNAVAILABLE: "unavailable",
}


class ApiError(Exception):
    """Domain failure that maps onto a specific HTTP status and error code."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        fields: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.fields = fields or {}
        self.headers = headers or {}

    def to_payload(self) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "fields": self.fields,
            }
        }


def task_not_found(task_id: str) -> ApiError:
    return ApiError(
        status.HTTP_404_NOT_FOUND,
        "task_not_found",
        f"No task with id {task_id!r}.",
    )


def invalid_prompt(message: str) -> ApiError:
    return ApiError(
        HTTP_422_UNPROCESSABLE,
        "invalid_prompt",
        message,
        fields={"prompt": message},
    )


def invalid_state(message: str) -> ApiError:
    return ApiError(status.HTTP_409_CONFLICT, "invalid_state", message)


def service_unavailable(message: str, code: str = "unavailable") -> ApiError:
    return ApiError(status.HTTP_503_SERVICE_UNAVAILABLE, code, message)


def _error_body(
    status_code: int, code: str | None, message: str, fields: dict[str, str] | None
) -> dict[str, Any]:
    return {
        "error": {
            "code": code or DEFAULT_CODES.get(status_code, "error"),
            "message": message,
            "fields": fields or {},
        }
    }


def _flatten_validation_errors(exc: RequestValidationError) -> dict[str, str]:
    """Turn FastAPI validation errors into ``{field: message}``.

    ``loc`` is a tuple such as ``("body", "prompt")``; only the last element is
    a field name, so it is what the frontend's composer can attach to an input.
    """
    fields: dict[str, str] = {}
    for error in exc.errors():
        location = [str(part) for part in error.get("loc", []) if part not in {"body", "query", "path"}]
        field = location[-1] if location else "request"
        message = str(error.get("msg", "Invalid value."))
        # First error per field wins: it is the most specific one.
        fields.setdefault(field, message)
    return fields


def register_exception_handlers(app: FastAPI) -> None:
    """Attach the handlers that guarantee a uniform error envelope."""

    @app.exception_handler(ApiError)
    async def _handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
        if exc.status_code >= 500:
            logger.error("api_error code=%s status=%s", exc.code, exc.status_code)
        return JSONResponse(
            status_code=exc.status_code,
            content=exc.to_payload(),
            headers=exc.headers or None,
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = _flatten_validation_errors(exc)
        logger.info("validation_error fields=%s", sorted(fields))
        return JSONResponse(
            status_code=HTTP_422_UNPROCESSABLE,
            content=_error_body(
                HTTP_422_UNPROCESSABLE,
                "validation_error",
                "The request could not be processed.",
                fields,
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def _handle_http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail
        code: str | None = None
        fields: dict[str, str] = {}
        message = str(detail) if detail else "Request failed."
        if isinstance(detail, dict) and "error" in detail:
            # Already in envelope form (e.g. re-raised by another handler).
            return JSONResponse(status_code=exc.status_code, content=detail, headers=exc.headers)
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_body(exc.status_code, code, message, fields),
            headers=exc.headers,
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        # Log the class and message only; request bodies can contain user prompts
        # and are never written to logs.
        logger.exception("unhandled_error path=%s error=%s", request.url.path, type(exc).__name__)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_error_body(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "internal_error",
                "The service reported an internal error.",
            ),
        )
