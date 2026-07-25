# pyright: reportUnusedFunction=false
"""FastAPI routes for journal entries, measurements, and photos."""

from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse

from cultivation_assistant.db.engine import Database
from cultivation_assistant.journal.schemas import (
    JournalEntryCreate,
    JournalEntryListResponse,
    JournalEntryResponse,
    JournalEntryUpdate,
    MeasurementCreate,
    MeasurementListResponse,
    MeasurementResponse,
    MeasurementUpdate,
    PhotoListResponse,
    PhotoResponse,
    PhotoUpdate,
    TimelineListResponse,
)
from cultivation_assistant.journal.service import (
    JournalNotFound,
    JournalService,
    JournalStorageError,
    JournalValidationError,
)
from cultivation_assistant.journal.storage import PhotoStorage
from cultivation_assistant.middleware import correlation_id


async def _map_domain_errors[ResponseType](
    operation: Callable[[], Awaitable[ResponseType]],
) -> ResponseType:
    try:
        return await operation()
    except JournalNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except JournalValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except JournalStorageError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


def create_router(database: Database, data_dir: Path) -> APIRouter:
    """Create a router bound to process-local infrastructure."""
    router = APIRouter(tags=["journal"])
    service = JournalService(database, PhotoStorage(data_dir))

    @router.post(
        "/plants/{plant_id}/journal-entries",
        response_model=JournalEntryResponse,
        status_code=201,
    )
    async def create_plant_journal_entry(
        plant_id: str, request: JournalEntryCreate
    ) -> JournalEntryResponse:
        return await _map_domain_errors(
            lambda: service.create_for_plant(plant_id, request, correlation_id.get())
        )

    @router.get(
        "/plants/{plant_id}/journal-entries",
        response_model=JournalEntryListResponse,
    )
    async def list_plant_journal_entries(plant_id: str) -> JournalEntryListResponse:
        return await _map_domain_errors(lambda: service.list_for_plant(plant_id))

    @router.post(
        "/grows/{grow_id}/journal-entries",
        response_model=JournalEntryResponse,
        status_code=201,
    )
    async def create_grow_journal_entry(
        grow_id: str, request: JournalEntryCreate
    ) -> JournalEntryResponse:
        return await _map_domain_errors(
            lambda: service.create_for_grow(grow_id, request, correlation_id.get())
        )

    @router.get(
        "/grows/{grow_id}/journal-entries",
        response_model=JournalEntryListResponse,
    )
    async def list_grow_journal_entries(grow_id: str) -> JournalEntryListResponse:
        return await _map_domain_errors(lambda: service.list_for_grow(grow_id))

    @router.patch(
        "/journal-entries/{entry_id}",
        response_model=JournalEntryResponse,
    )
    async def update_journal_entry(
        entry_id: str, request: JournalEntryUpdate
    ) -> JournalEntryResponse:
        return await _map_domain_errors(
            lambda: service.update(entry_id, request, correlation_id.get())
        )

    @router.delete(
        "/journal-entries/{entry_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_journal_entry(entry_id: str) -> Response:
        await _map_domain_errors(lambda: service.delete(entry_id, correlation_id.get()))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/plants/{plant_id}/measurements",
        response_model=MeasurementResponse,
        status_code=201,
    )
    async def create_measurement(
        plant_id: str, request: MeasurementCreate
    ) -> MeasurementResponse:
        return await _map_domain_errors(
            lambda: service.create_measurement(plant_id, request, correlation_id.get())
        )

    @router.get(
        "/plants/{plant_id}/measurements",
        response_model=MeasurementListResponse,
    )
    async def list_measurements(plant_id: str) -> MeasurementListResponse:
        return await _map_domain_errors(lambda: service.list_measurements(plant_id))

    @router.patch(
        "/measurements/{measurement_id}",
        response_model=MeasurementResponse,
    )
    async def update_measurement(
        measurement_id: str, request: MeasurementUpdate
    ) -> MeasurementResponse:
        return await _map_domain_errors(
            lambda: service.update_measurement(measurement_id, request, correlation_id.get())
        )

    @router.delete(
        "/measurements/{measurement_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_measurement(measurement_id: str) -> Response:
        await _map_domain_errors(
            lambda: service.delete_measurement(measurement_id, correlation_id.get())
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/plants/{plant_id}/photos",
        response_model=PhotoResponse,
        status_code=201,
    )
    async def create_photo(
        plant_id: str,
        file: UploadFile,
        caption: Annotated[str | None, Form()] = None,
        tags: Annotated[list[str] | None, Form()] = None,
        journal_entry_id: Annotated[str | None, Form()] = None,
        measurement_id: Annotated[str | None, Form()] = None,
        stage_id: Annotated[str | None, Form()] = None,
        occurred_at: Annotated[datetime | None, Form()] = None,
    ) -> PhotoResponse:
        content = await file.read()
        return await _map_domain_errors(
            lambda: service.create_photo(
                plant_id,
                content=content,
                content_type=file.content_type or "application/octet-stream",
                caption=caption,
                tags=tags or [],
                journal_entry_id=journal_entry_id,
                measurement_id=measurement_id,
                stage_id=stage_id,
                occurred_at=occurred_at,
                correlation_id=correlation_id.get(),
            )
        )

    @router.get(
        "/plants/{plant_id}/photos",
        response_model=PhotoListResponse,
    )
    async def list_photos(plant_id: str) -> PhotoListResponse:
        return await _map_domain_errors(lambda: service.list_photos(plant_id))

    @router.get("/photos/{photo_id}/file")
    async def get_photo_file(photo_id: str) -> FileResponse:
        absolute_path, content_type = await _map_domain_errors(
            lambda: service.get_photo_file(photo_id)
        )
        return FileResponse(absolute_path, media_type=content_type)

    @router.patch(
        "/photos/{photo_id}",
        response_model=PhotoResponse,
    )
    async def update_photo(photo_id: str, request: PhotoUpdate) -> PhotoResponse:
        return await _map_domain_errors(
            lambda: service.update_photo(photo_id, request, correlation_id.get())
        )

    @router.delete(
        "/photos/{photo_id}",
        status_code=status.HTTP_204_NO_CONTENT,
        response_class=Response,
    )
    async def delete_photo(photo_id: str) -> Response:
        await _map_domain_errors(lambda: service.delete_photo(photo_id, correlation_id.get()))
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.get(
        "/plants/{plant_id}/timeline",
        response_model=TimelineListResponse,
    )
    async def get_plant_timeline(
        plant_id: str,
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> TimelineListResponse:
        return await _map_domain_errors(
            lambda: service.get_plant_timeline(plant_id, limit=limit, offset=offset)
        )

    return router
