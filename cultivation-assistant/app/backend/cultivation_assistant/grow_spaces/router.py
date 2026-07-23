# pyright: reportUnusedFunction=false
"""FastAPI routes for grow spaces and environmental mappings."""

from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, Query, Response, status

from cultivation_assistant.db.engine import Database
from cultivation_assistant.grow_spaces.discovery import EntityDiscoveryService
from cultivation_assistant.grow_spaces.schemas import (
    EntityDiscoveryResponse,
    EntityMappingCreate,
    EntityMappingResponse,
    EntityMappingUpdate,
    GrowSpaceCreate,
    GrowSpaceListResponse,
    GrowSpaceResponse,
    GrowSpaceUpdate,
)
from cultivation_assistant.grow_spaces.service import (
    GrowSpaceConflict,
    GrowSpaceNotFound,
    GrowSpaceService,
    GrowSpaceValidationError,
)
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.middleware import correlation_id
from cultivation_assistant.runtime import RuntimeStatus


async def _map_domain_errors[ResponseType](
    operation: Callable[[], Awaitable[ResponseType]],
) -> ResponseType:
    try:
        return await operation()
    except GrowSpaceNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except GrowSpaceConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except GrowSpaceValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def create_router(
    database: Database,
    state_cache: EntityStateCache,
    runtime_status: RuntimeStatus,
) -> APIRouter:
    """Create a router bound to process-local infrastructure."""
    router = APIRouter(tags=["grow spaces"])
    service = GrowSpaceService(database, state_cache)
    discovery = EntityDiscoveryService(state_cache)

    @router.get(
        "/home-assistant/entities",
        response_model=EntityDiscoveryResponse,
        tags=["home assistant"],
    )
    async def discover_home_assistant_entities(role: str) -> EntityDiscoveryResponse:
        if not runtime_status.home_assistant_connected:
            raise HTTPException(
                status_code=503,
                detail="Home Assistant entity discovery is unavailable",
            )
        try:
            return EntityDiscoveryResponse(items=discovery.suggest(role))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.get("/grow-spaces", response_model=GrowSpaceListResponse)
    async def list_grow_spaces(
        include_archived: bool = Query(default=False),
    ) -> GrowSpaceListResponse:
        return await _map_domain_errors(
            lambda: service.list_spaces(include_archived=include_archived)
        )

    @router.post(
        "/grow-spaces",
        response_model=GrowSpaceResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_grow_space(request: GrowSpaceCreate) -> GrowSpaceResponse:
        return await _map_domain_errors(lambda: service.create(request, correlation_id.get()))

    @router.get("/grow-spaces/{grow_space_id}", response_model=GrowSpaceResponse)
    async def get_grow_space(grow_space_id: str) -> GrowSpaceResponse:
        return await _map_domain_errors(lambda: service.get(grow_space_id))

    @router.patch("/grow-spaces/{grow_space_id}", response_model=GrowSpaceResponse)
    async def update_grow_space(
        grow_space_id: str,
        request: GrowSpaceUpdate,
    ) -> GrowSpaceResponse:
        return await _map_domain_errors(
            lambda: service.update(grow_space_id, request, correlation_id.get())
        )

    @router.delete(
        "/grow-spaces/{grow_space_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def archive_grow_space(grow_space_id: str) -> Response:
        await _map_domain_errors(lambda: service.archive(grow_space_id, correlation_id.get()))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/grow-spaces/{grow_space_id}/entity-mappings",
        response_model=EntityMappingResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_entity_mapping(
        grow_space_id: str,
        request: EntityMappingCreate,
    ) -> EntityMappingResponse:
        return await _map_domain_errors(
            lambda: service.create_mapping(
                grow_space_id,
                request,
                correlation_id.get(),
            )
        )

    @router.patch(
        "/grow-spaces/{grow_space_id}/entity-mappings/{mapping_id}",
        response_model=EntityMappingResponse,
    )
    async def update_entity_mapping(
        grow_space_id: str,
        mapping_id: str,
        request: EntityMappingUpdate,
    ) -> EntityMappingResponse:
        return await _map_domain_errors(
            lambda: service.update_mapping(
                grow_space_id,
                mapping_id,
                request,
                correlation_id.get(),
            )
        )

    @router.delete(
        "/grow-spaces/{grow_space_id}/entity-mappings/{mapping_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_entity_mapping(
        grow_space_id: str,
        mapping_id: str,
    ) -> Response:
        await _map_domain_errors(
            lambda: service.delete_mapping(
                grow_space_id,
                mapping_id,
                correlation_id.get(),
            )
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
