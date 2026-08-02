# pyright: reportUnusedFunction=false
"""FastAPI routes for Plants and stage transitions."""

from collections.abc import Awaitable, Callable
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, status

from cultivation_assistant.db.engine import Database
from cultivation_assistant.middleware import correlation_id
from cultivation_assistant.plants.schemas import (
    PlantCreate,
    PlantListResponse,
    PlantResponse,
    PlantStageTransitionCreate,
    PlantStageTransitionResult,
    PlantUpdate,
)
from cultivation_assistant.plants.service import (
    PlantConflict,
    PlantNotFound,
    PlantService,
    PlantTransitionConfirmationRequired,
    PlantValidationError,
)


async def _map_domain_errors[ResponseType](
    operation: Callable[[], Awaitable[ResponseType]],
) -> ResponseType:
    try:
        return await operation()
    except PlantNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PlantConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PlantTransitionConfirmationRequired as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "transition_confirmation_required",
                "message": str(exc),
            },
        ) from exc
    except PlantValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def create_router(database: Database) -> APIRouter:
    """Create a router bound to process-local infrastructure."""
    router = APIRouter(tags=["plants"])
    service = PlantService(database)

    @router.get("/plants", response_model=PlantListResponse)
    async def list_plants(
        grow_id: str | None = Query(default=None),
        grow_space_id: str | None = Query(default=None),
        status: Annotated[list[str] | None, Query()] = None,
        stage_id: str | None = Query(default=None),
        query: str | None = Query(default=None),
        include_archived: bool = Query(default=False),
    ) -> PlantListResponse:
        return await _map_domain_errors(
            lambda: service.list_plants(
                grow_id=grow_id,
                grow_space_id=grow_space_id,
                statuses=status,
                stage_id=stage_id,
                query=query,
                include_archived=include_archived,
            )
        )

    @router.post("/plants", response_model=PlantResponse, status_code=201)
    async def create_plant(request: PlantCreate) -> PlantResponse:
        return await _map_domain_errors(
            lambda: service.create(request, correlation_id.get())
        )

    @router.get("/plants/{plant_id}", response_model=PlantResponse)
    async def get_plant(plant_id: str) -> PlantResponse:
        return await _map_domain_errors(lambda: service.get(plant_id))

    @router.patch("/plants/{plant_id}", response_model=PlantResponse)
    async def update_plant(plant_id: str, request: PlantUpdate) -> PlantResponse:
        return await _map_domain_errors(
            lambda: service.update(plant_id, request, correlation_id.get())
        )

    @router.delete(
        "/plants/{plant_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def archive_plant(plant_id: str) -> Response:
        await _map_domain_errors(lambda: service.archive(plant_id, correlation_id.get()))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/plants/{plant_id}/stage-transitions",
        response_model=PlantStageTransitionResult,
        status_code=201,
    )
    async def create_transition(
        plant_id: str, request: PlantStageTransitionCreate
    ) -> PlantStageTransitionResult:
        return await _map_domain_errors(
            lambda: service.transition_stage(plant_id, request, correlation_id.get())
        )

    return router
