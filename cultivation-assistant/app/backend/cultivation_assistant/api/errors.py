"""Consistent API error responses."""

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Translate FastAPI HTTP errors to the public error envelope."""
    del request
    detail = exc.detail
    details: dict[str, Any] = {}
    if isinstance(detail, dict) and "code" in detail:
        code = str(detail["code"])
        message = str(detail.get("message", ""))
        details = detail.get("details", {})
    elif exc.status_code == 404:
        code = "not_found"
        message = "The requested resource was not found."
        details = {}
    else:
        code = "http_error"
        message = str(detail)
        details = {}

    content: dict[str, dict[str, Any]] = {
        "error": {"code": code, "message": message, "details": details}
    }
    return JSONResponse(status_code=exc.status_code, content=content, headers=exc.headers)
