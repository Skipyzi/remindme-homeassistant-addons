# pyright: reportUnusedFunction=false
"""FastAPI routes for reservoirs."""

from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, Query, Response, status

from cultivation_assistant.db.engine import Database
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.middleware import correlation_id
from cultivation_assistant.reservoirs.schemas import (
    CalibrationPointListResponse,
    CalibrationPointsReplace,
    EntityDiscoveryResponse,
    ReservoirCreate,
    ReservoirDashboardResponse,
    ReservoirListResponse,
    ReservoirMappingCreate,
    ReservoirMappingResponse,
    ReservoirMappingUpdate,
    ReservoirResponse,
    ReservoirUpdate,
)
from cultivation_assistant.reservoirs.service import (
    ReservoirConflict,
    ReservoirNotFound,
    ReservoirService,
    ReservoirValidationError,
)
from cultivation_assistant.runtime import RuntimeStatus


async def _map_domain_errors[ResponseType](
    operation: Callable[[], Awaitable[ResponseType]],
) -> ResponseType:
    try:
        return await operation()
    except ReservoirNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ReservoirConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ReservoirValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def create_router(
    database: Database,
    state_cache: EntityStateCache,
    runtime_status: RuntimeStatus,
) -> APIRouter:
    """Create a router bound to process-local infrastructure."""
    router = APIRouter(tags=["reservoirs"])
    service = ReservoirService(database, state_cache)

    @router.get("/reservoirs", response_model=ReservoirListResponse)
    async def list_reservoirs(
        include_archived: bool = Query(default=False),
    ) -> ReservoirListResponse:
        return await _map_domain_errors(
            lambda: service.list_reservoirs(include_archived=include_archived)
        )

    @router.post("/reservoirs", response_model=ReservoirResponse, status_code=201)
    async def create_reservoir(request: ReservoirCreate) -> ReservoirResponse:
        return await _map_domain_errors(
            lambda: service.create(request, correlation_id.get())
        )

    @router.get("/reservoirs/{reservoir_id}", response_model=ReservoirResponse)
    async def get_reservoir(reservoir_id: str) -> ReservoirResponse:
        return await _map_domain_errors(lambda: service.get(reservoir_id))

    @router.patch("/reservoirs/{reservoir_id}", response_model=ReservoirResponse)
    async def update_reservoir(
        reservoir_id: str, request: ReservoirUpdate
    ) -> ReservoirResponse:
        return await _map_domain_errors(
            lambda: service.update(reservoir_id, request, correlation_id.get())
        )

    @router.delete(
        "/reservoirs/{reservoir_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def archive_reservoir(reservoir_id: str) -> Response:
        await _map_domain_errors(
            lambda: service.archive(reservoir_id, correlation_id.get())
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.get(
        "/reservoirs/{reservoir_id}/calibration-points",
        response_model=CalibrationPointListResponse,
    )
    async def list_calibration_points(reservoir_id: str) -> CalibrationPointListResponse:
        return await _map_domain_errors(
            lambda: service.list_calibration_points(reservoir_id)
        )

    @router.put(
        "/reservoirs/{reservoir_id}/calibration-points",
        response_model=CalibrationPointListResponse,
    )
    async def replace_calibration_points(
        reservoir_id: str, request: CalibrationPointsReplace
    ) -> CalibrationPointListResponse:
        return await _map_domain_errors(
            lambda: service.replace_calibration_points(
                reservoir_id, request, correlation_id.get()
            )
        )

    @router.get(
        "/reservoirs/{reservoir_id}/dashboard",
        response_model=ReservoirDashboardResponse,
    )
    async def get_reservoir_dashboard(reservoir_id: str) -> ReservoirDashboardResponse:
        return await _map_domain_errors(lambda: service.dashboard(reservoir_id))

    @router.get(
        "/home-assistant/reservoir-entities",
        response_model=EntityDiscoveryResponse,
        tags=["home assistant"],
    )
    async def discover_reservoir_entities(role: str) -> EntityDiscoveryResponse:
        if not runtime_status.home_assistant_connected:
            raise HTTPException(
                status_code=503,
                detail="Home Assistant entity discovery is unavailable",
            )
        try:
            return await service.suggest_entities(role)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.post(
        "/reservoirs/{reservoir_id}/entity-mappings",
        response_model=ReservoirMappingResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_entity_mapping(
        reservoir_id: str, request: ReservoirMappingCreate
    ) -> ReservoirMappingResponse:
        return await _map_domain_errors(
            lambda: service.create_mapping(reservoir_id, request, correlation_id.get())
        )

    @router.patch(
        "/reservoirs/{reservoir_id}/entity-mappings/{mapping_id}",
        response_model=ReservoirMappingResponse,
    )
    async def update_entity_mapping(
        reservoir_id: str,
        mapping_id: str,
        request: ReservoirMappingUpdate,
    ) -> ReservoirMappingResponse:
        return await _map_domain_errors(
            lambda: service.update_mapping(
                reservoir_id, mapping_id, request, correlation_id.get()
            )
        )

    @router.delete(
        "/reservoirs/{reservoir_id}/entity-mappings/{mapping_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_entity_mapping(
        reservoir_id: str, mapping_id: str
    ) -> Response:
        await _map_domain_errors(
            lambda: service.delete_mapping(reservoir_id, mapping_id, correlation_id.get())
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
