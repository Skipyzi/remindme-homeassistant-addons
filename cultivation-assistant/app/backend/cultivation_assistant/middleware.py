"""HTTP middleware shared by the API."""

from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from uuid import uuid4

from fastapi import Request, Response

correlation_id: ContextVar[str] = ContextVar("correlation_id", default="")


async def correlation_id_middleware(
    request: Request,
    call_next: Callable[[Request], Awaitable[Response]],
) -> Response:
    """Attach a stable request correlation identifier to the response."""
    request_id = request.headers.get("X-Correlation-ID") or str(uuid4())
    token = correlation_id.set(request_id)
    try:
        response = await call_next(request)
        response.headers["X-Correlation-ID"] = request_id
        return response
    finally:
        correlation_id.reset(token)
