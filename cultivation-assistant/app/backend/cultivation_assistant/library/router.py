# pyright: reportUnusedFunction=false
"""FastAPI routes for breeders and cultivars."""

from collections.abc import Awaitable, Callable

from fastapi import APIRouter, HTTPException, Query, status

from cultivation_assistant.db.engine import Database
from cultivation_assistant.library.schemas import (
    BreederCreate,
    BreederListResponse,
    BreederResponse,
    BreederUpdate,
    CultivarCreate,
    CultivarListResponse,
    CultivarResponse,
    CultivarUpdate,
)
from cultivation_assistant.library.service import (
    LibraryConflict,
    LibraryNotFound,
    LibraryService,
    LibraryValidationError,
)
from cultivation_assistant.middleware import correlation_id


async def _map_domain_errors[ResponseType](
    operation: Callable[[], Awaitable[ResponseType]],
) -> ResponseType:
    try:
        return await operation()
    except LibraryNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except LibraryConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except LibraryValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def create_router(database: Database) -> APIRouter:
    """Create a router bound to process-local infrastructure."""
    router = APIRouter(tags=["library"])
    service = LibraryService(database)

    @router.get("/breeders", response_model=BreederListResponse)
    async def list_breeders(
        include_inactive: bool = Query(default=False),
    ) -> BreederListResponse:
        return await _map_domain_errors(
            lambda: service.list_breeders(include_inactive=include_inactive)
        )

    @router.post(
        "/breeders",
        response_model=BreederResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_breeder(request: BreederCreate) -> BreederResponse:
        return await _map_domain_errors(
            lambda: service.create_breeder(request, correlation_id.get())
        )

    @router.patch("/breeders/{breeder_id}", response_model=BreederResponse)
    async def update_breeder(breeder_id: str, request: BreederUpdate) -> BreederResponse:
        return await _map_domain_errors(
            lambda: service.update_breeder(breeder_id, request, correlation_id.get())
        )

    @router.get("/cultivars", response_model=CultivarListResponse)
    async def list_cultivars(
        include_inactive: bool = Query(default=False),
        breeder_id: str | None = Query(default=None),
        query: str | None = Query(default=None),
    ) -> CultivarListResponse:
        return await _map_domain_errors(
            lambda: service.list_cultivars(
                include_inactive=include_inactive,
                breeder_id=breeder_id,
                query=query,
            )
        )

    @router.post(
        "/cultivars",
        response_model=CultivarResponse,
        status_code=status.HTTP_201_CREATED,
    )
    async def create_cultivar(request: CultivarCreate) -> CultivarResponse:
        return await _map_domain_errors(
            lambda: service.create_cultivar(request, correlation_id.get())
        )

    @router.patch("/cultivars/{cultivar_id}", response_model=CultivarResponse)
    async def update_cultivar(
        cultivar_id: str, request: CultivarUpdate
    ) -> CultivarResponse:
        return await _map_domain_errors(
            lambda: service.update_cultivar(cultivar_id, request, correlation_id.get())
        )

    return router
