# pyright: reportUnusedFunction=false
"""FastAPI routes for Grows."""

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status

from cultivation_assistant.db.engine import Database
from cultivation_assistant.grows.schemas import (
    GrowCreate,
    GrowListResponse,
    GrowResponse,
    GrowUpdate,
)
from cultivation_assistant.grows.service import (
    GrowConflict,
    GrowNotFound,
    GrowService,
    GrowValidationError,
)
from cultivation_assistant.middleware import correlation_id


async def _map_domain_errors[ResponseType](
    operation: Callable[[], Awaitable[ResponseType]],
) -> ResponseType:
    try:
        return await operation()
    except GrowNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GrowConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except GrowValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def create_router(database: Database) -> APIRouter:
    """Create a router bound to process-local infrastructure."""
    router = APIRouter(tags=["grows"])
    service = GrowService(database)

    @router.get("/grows", response_model=GrowListResponse)
    async def list_grows(
        grow_space_id: str | None = Query(default=None),
        status: Annotated[list[str] | None, Query()] = None,
        include_archived: bool = Query(default=False),
    ) -> GrowListResponse:
        return await _map_domain_errors(
            lambda: service.list_grows(
                grow_space_id=grow_space_id,
                statuses=status,
                include_archived=include_archived,
            )
        )

    @router.post(
        "/grows",
        response_model=GrowResponse,
        status_code=201,
    )
    async def create_grow(request: GrowCreate) -> GrowResponse:
        return await _map_domain_errors(
            lambda: service.create(request, correlation_id.get())
        )

    @router.get("/grows/{grow_id}", response_model=GrowResponse)
    async def get_grow(grow_id: str) -> GrowResponse:
        return await _map_domain_errors(lambda: service.get(grow_id))

    @router.patch("/grows/{grow_id}", response_model=GrowResponse)
    async def update_grow(grow_id: str, request: GrowUpdate) -> GrowResponse:
        return await _map_domain_errors(
            lambda: service.update(grow_id, request, correlation_id.get())
        )

    @router.delete(
        "/grows/{grow_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def archive_grow(grow_id: str) -> Response:
        await _map_domain_errors(lambda: service.archive(grow_id, correlation_id.get()))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
