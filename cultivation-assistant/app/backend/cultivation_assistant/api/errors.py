"""Consistent API error responses."""

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Translate FastAPI HTTP errors to the public error envelope."""
    del request
    if exc.status_code == 404:
        code = "not_found"
        message = "The requested resource was not found."
    else:
        code = "http_error"
        message = str(exc.detail)

    content: dict[str, dict[str, Any]] = {
        "error": {"code": code, "message": message, "details": {}}
    }
    return JSONResponse(status_code=exc.status_code, content=content, headers=exc.headers)
