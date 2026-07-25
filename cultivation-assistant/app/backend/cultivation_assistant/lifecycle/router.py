# pyright: reportUnusedFunction=false
"""FastAPI routes for lifecycle stages."""

from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, Query, Response, status

from cultivation_assistant.db.engine import Database
from cultivation_assistant.lifecycle.schemas import (
    LifecycleStageCreate,
    LifecycleStageListResponse,
    LifecycleStageOrderUpdate,
    LifecycleStageResponse,
    LifecycleStageUpdate,
)
from cultivation_assistant.lifecycle.service import (
    LifecycleStageConflict,
    LifecycleStageNotFound,
    LifecycleStageService,
    LifecycleStageValidationError,
)
from cultivation_assistant.middleware import correlation_id


async def _map_domain_errors[ResponseType](
    operation: Callable[[], Awaitable[ResponseType]],
) -> ResponseType:
    try:
        return await operation()
    except LifecycleStageNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except LifecycleStageConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LifecycleStageValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def create_router(database: Database) -> APIRouter:
    """Create a router bound to process-local infrastructure."""
    router = APIRouter(tags=["lifecycle"])
    service = LifecycleStageService(database)

    @router.get("/lifecycle-stages", response_model=LifecycleStageListResponse)
    async def list_stages(
        include_disabled: bool = Query(default=False),
    ) -> LifecycleStageListResponse:
        return await _map_domain_errors(
            lambda: service.list_stages(include_disabled=include_disabled)
        )

    @router.post(
        "/lifecycle-stages",
        response_model=LifecycleStageResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_stage(request: LifecycleStageCreate) -> LifecycleStageResponse:
        return await _map_domain_errors(
            lambda: service.create_stage(request, correlation_id.get())
        )

    @router.put("/lifecycle-stages/order", response_model=LifecycleStageListResponse)
    async def reorder_stages(
        request: LifecycleStageOrderUpdate,
    ) -> LifecycleStageListResponse:
        return await _map_domain_errors(
            lambda: service.reorder(request, correlation_id.get())
        )

    @router.patch(
        "/lifecycle-stages/{stage_id}", response_model=LifecycleStageResponse
    )
    async def update_stage(
        stage_id: str, request: LifecycleStageUpdate
    ) -> LifecycleStageResponse:
        return await _map_domain_errors(
            lambda: service.update_stage(stage_id, request, correlation_id.get())
        )

    @router.delete(
        "/lifecycle-stages/{stage_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_stage(stage_id: str) -> Response:
        await _map_domain_errors(
            lambda: service.delete_stage(stage_id, correlation_id.get())
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
