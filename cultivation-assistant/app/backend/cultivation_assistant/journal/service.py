"""Transactional application service for the journal slice."""

from datetime import datetime
from pathlib import Path
from uuid import uuid4

from cultivation_assistant.audit import audit_record
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import (
    JournalEntry,
    Measurement,
    Photo,
    PlantStageTransition,
)
from cultivation_assistant.journal.repository import JournalRepository
from cultivation_assistant.journal.rules import (
    PHOTO_CONTENT_TYPES,
    JournalSubjectType,
    MeasurementMetric,
    requires_custom_metric_name,
)
from cultivation_assistant.journal.schemas import (
    CompactStageRef,
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
    TimelineEntryResponse,
    TimelineListResponse,
    TimelineStageTransition,
    default_occurred_at,
)
from cultivation_assistant.journal.storage import PhotoStorage

MAX_PHOTO_SIZE = 15 * 1024 * 1024


class JournalNotFound(RuntimeError):
    """Raised when a journal-slice record or its subject does not exist."""


class JournalValidationError(RuntimeError):
    """Raised when domain validation rejects a requested change."""


class JournalStorageError(RuntimeError):
    """Raised when writing a photo to disk fails after its row was committed."""


class JournalService:
    """Apply journal-entry policy inside explicit transactions."""

    def __init__(self, database: Database, photo_storage: PhotoStorage) -> None:
        self._database = database
        self._photo_storage = photo_storage

    async def create_for_plant(
        self, plant_id: str, request: JournalEntryCreate, correlation_id: str
    ) -> JournalEntryResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_plant(plant_id) is None:
                raise JournalNotFound("Plant was not found")
            entry = await self._create_entry(
                repository, JournalSubjectType.PLANT, plant_id, request
            )
            session.add(
                audit_record(
                    "journal_entry.created",
                    "journal_entry",
                    entry.id,
                    correlation_id,
                    details={"subject_type": "plant", "subject_id": plant_id},
                )
            )
            await session.flush()
            return self._response(entry)

    async def create_for_grow(
        self, grow_id: str, request: JournalEntryCreate, correlation_id: str
    ) -> JournalEntryResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_grow(grow_id) is None:
                raise JournalNotFound("Grow was not found")
            if request.related_stage_id is not None:
                raise JournalValidationError(
                    "A related stage only applies to a Plant journal entry"
                )
            entry = await self._create_entry(
                repository, JournalSubjectType.GROW, grow_id, request
            )
            session.add(
                audit_record(
                    "journal_entry.created",
                    "journal_entry",
                    entry.id,
                    correlation_id,
                    details={"subject_type": "grow", "subject_id": grow_id},
                )
            )
            await session.flush()
            return self._response(entry)

    async def list_for_plant(self, plant_id: str) -> JournalEntryListResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_plant(plant_id) is None:
                raise JournalNotFound("Plant was not found")
            entries = await repository.list_entries("plant", plant_id)
            return JournalEntryListResponse(
                items=[self._response(entry) for entry in entries]
            )

    async def list_for_grow(self, grow_id: str) -> JournalEntryListResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_grow(grow_id) is None:
                raise JournalNotFound("Grow was not found")
            entries = await repository.list_entries("grow", grow_id)
            return JournalEntryListResponse(
                items=[self._response(entry) for entry in entries]
            )

    async def update(
        self, entry_id: str, request: JournalEntryUpdate, correlation_id: str
    ) -> JournalEntryResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            entry = await repository.get_entry(entry_id)
            if entry is None:
                raise JournalNotFound("Journal entry was not found")
            if request.related_stage_id is not None:
                if entry.subject_type != JournalSubjectType.PLANT.value:
                    raise JournalValidationError(
                        "A related stage only applies to a Plant journal entry"
                    )
                if await repository.get_stage(request.related_stage_id) is None:
                    raise JournalNotFound("Lifecycle stage was not found")
            self._apply_update(entry, request)
            session.add(
                audit_record("journal_entry.updated", "journal_entry", entry.id, correlation_id)
            )
            await session.flush()
            refreshed = await repository.get_entry(entry.id)
            assert refreshed is not None
            return self._response(refreshed)

    async def delete(self, entry_id: str, correlation_id: str) -> None:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            entry = await repository.get_entry(entry_id)
            if entry is None:
                raise JournalNotFound("Journal entry was not found")
            session.add(
                audit_record("journal_entry.deleted", "journal_entry", entry.id, correlation_id)
            )
            await repository.delete_entry(entry)

    async def create_measurement(
        self, plant_id: str, request: MeasurementCreate, correlation_id: str
    ) -> MeasurementResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_plant(plant_id) is None:
                raise JournalNotFound("Plant was not found")
            measurement = Measurement(
                plant_id=plant_id,
                metric_type=request.metric_type.value,
                custom_metric_name=request.custom_metric_name,
                value=request.value,
                unit=request.unit,
                occurred_at=request.occurred_at or default_occurred_at(),
                notes=request.notes,
            )
            await repository.add_measurement(measurement)
            session.add(
                audit_record(
                    "measurement.created",
                    "measurement",
                    measurement.id,
                    correlation_id,
                    details={"plant_id": plant_id, "metric_type": measurement.metric_type},
                )
            )
            await session.flush()
            return self._measurement_response(measurement)

    async def list_measurements(self, plant_id: str) -> MeasurementListResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_plant(plant_id) is None:
                raise JournalNotFound("Plant was not found")
            measurements = await repository.list_measurements(plant_id)
            return MeasurementListResponse(
                items=[self._measurement_response(item) for item in measurements]
            )

    async def update_measurement(
        self, measurement_id: str, request: MeasurementUpdate, correlation_id: str
    ) -> MeasurementResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            measurement = await repository.get_measurement(measurement_id)
            if measurement is None:
                raise JournalNotFound("Measurement was not found")
            resulting_metric = (
                request.metric_type.value
                if request.metric_type is not None
                else measurement.metric_type
            )
            resulting_custom_name = (
                request.custom_metric_name
                if "custom_metric_name" in request.model_fields_set
                else measurement.custom_metric_name
            )
            resulting_metric_type = MeasurementMetric(resulting_metric)
            if requires_custom_metric_name(resulting_metric_type, resulting_custom_name):
                raise JournalValidationError("A custom measurement requires a metric name")
            self._apply_measurement_update(measurement, request)
            session.add(
                audit_record(
                    "measurement.updated", "measurement", measurement.id, correlation_id
                )
            )
            await session.flush()
            refreshed = await repository.get_measurement(measurement.id)
            assert refreshed is not None
            return self._measurement_response(refreshed)

    async def delete_measurement(self, measurement_id: str, correlation_id: str) -> None:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            measurement = await repository.get_measurement(measurement_id)
            if measurement is None:
                raise JournalNotFound("Measurement was not found")
            session.add(
                audit_record(
                    "measurement.deleted", "measurement", measurement.id, correlation_id
                )
            )
            await repository.delete_measurement(measurement)

    @staticmethod
    def _apply_measurement_update(measurement: Measurement, request: MeasurementUpdate) -> None:
        if request.metric_type is not None:
            measurement.metric_type = request.metric_type.value
        if "custom_metric_name" in request.model_fields_set:
            measurement.custom_metric_name = request.custom_metric_name
        if request.value is not None:
            measurement.value = request.value
        if request.unit is not None:
            measurement.unit = request.unit
        if request.occurred_at is not None:
            measurement.occurred_at = request.occurred_at
        if "notes" in request.model_fields_set:
            measurement.notes = request.notes

    @staticmethod
    def _measurement_response(measurement: Measurement) -> MeasurementResponse:
        return MeasurementResponse(
            id=measurement.id,
            plant_id=measurement.plant_id,
            metric_type=MeasurementMetric(measurement.metric_type),
            custom_metric_name=measurement.custom_metric_name,
            value=measurement.value,
            unit=measurement.unit,
            occurred_at=measurement.occurred_at,
            notes=measurement.notes,
            created_at=measurement.created_at,
            updated_at=measurement.updated_at,
        )

    async def create_photo(
        self,
        plant_id: str,
        *,
        content: bytes,
        content_type: str,
        caption: str | None,
        tags: list[str],
        journal_entry_id: str | None,
        measurement_id: str | None,
        stage_id: str | None,
        occurred_at: datetime | None,
        correlation_id: str,
    ) -> PhotoResponse:
        if content_type not in PHOTO_CONTENT_TYPES:
            raise JournalValidationError(f"Unsupported photo content type: {content_type}")
        if len(content) > MAX_PHOTO_SIZE:
            raise JournalValidationError("Photo exceeds the 15 MB upload limit")

        photo_id = str(uuid4())
        relative_path = self._photo_storage.relative_path_for(plant_id, photo_id, content_type)

        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_plant(plant_id) is None:
                raise JournalNotFound("Plant was not found")
            if journal_entry_id is not None and await repository.get_entry(
                journal_entry_id
            ) is None:
                raise JournalNotFound("Journal entry was not found")
            if measurement_id is not None and await repository.get_measurement(
                measurement_id
            ) is None:
                raise JournalNotFound("Measurement was not found")
            if stage_id is not None and await repository.get_stage(stage_id) is None:
                raise JournalNotFound("Lifecycle stage was not found")

            photo = Photo(
                id=photo_id,
                plant_id=plant_id,
                journal_entry_id=journal_entry_id,
                measurement_id=measurement_id,
                stage_id=stage_id,
                caption=caption,
                tags=list(tags),
                file_path=relative_path,
                content_type=content_type,
                file_size=len(content),
                occurred_at=occurred_at or default_occurred_at(),
            )
            await repository.add_photo(photo)
            session.add(
                audit_record(
                    "photo.created",
                    "photo",
                    photo.id,
                    correlation_id,
                    details={"plant_id": plant_id, "content_type": content_type},
                )
            )
            await session.flush()
            response = self._photo_response(photo)

        try:
            self._photo_storage.write(relative_path, content)
        except OSError as exc:
            async with self._database.transaction() as session:
                repository = JournalRepository(session)
                stored = await repository.get_photo(photo_id)
                if stored is not None:
                    await repository.delete_photo(stored)
            raise JournalStorageError("Failed to write photo to disk") from exc

        return response

    async def list_photos(self, plant_id: str) -> PhotoListResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_plant(plant_id) is None:
                raise JournalNotFound("Plant was not found")
            photos = await repository.list_photos(plant_id)
            return PhotoListResponse(items=[self._photo_response(item) for item in photos])

    async def update_photo(
        self, photo_id: str, request: PhotoUpdate, correlation_id: str
    ) -> PhotoResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            photo = await repository.get_photo(photo_id)
            if photo is None:
                raise JournalNotFound("Photo was not found")
            if request.journal_entry_id is not None and await repository.get_entry(
                request.journal_entry_id
            ) is None:
                raise JournalNotFound("Journal entry was not found")
            if request.measurement_id is not None and await repository.get_measurement(
                request.measurement_id
            ) is None:
                raise JournalNotFound("Measurement was not found")
            if "caption" in request.model_fields_set:
                photo.caption = request.caption
            if request.tags is not None:
                photo.tags = list(request.tags)
            if "journal_entry_id" in request.model_fields_set:
                photo.journal_entry_id = request.journal_entry_id
            if "measurement_id" in request.model_fields_set:
                photo.measurement_id = request.measurement_id
            session.add(audit_record("photo.updated", "photo", photo.id, correlation_id))
            await session.flush()
            refreshed = await repository.get_photo(photo.id)
            assert refreshed is not None
            return self._photo_response(refreshed)

    async def delete_photo(self, photo_id: str, correlation_id: str) -> None:
        relative_path: str | None = None
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            photo = await repository.get_photo(photo_id)
            if photo is None:
                raise JournalNotFound("Photo was not found")
            relative_path = photo.file_path
            session.add(audit_record("photo.deleted", "photo", photo.id, correlation_id))
            await repository.delete_photo(photo)
        if relative_path is not None:
            self._photo_storage.delete(relative_path)

    async def get_photo_file(self, photo_id: str) -> tuple[Path, str]:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            photo = await repository.get_photo(photo_id)
            if photo is None:
                raise JournalNotFound("Photo was not found")
            absolute_path = self._photo_storage.absolute_path(photo.file_path)
            if not absolute_path.exists():
                raise JournalNotFound("Photo file was not found")
            return absolute_path, photo.content_type

    @staticmethod
    def _photo_response(photo: Photo) -> PhotoResponse:
        stage = (
            CompactStageRef.model_validate(photo.stage, from_attributes=True)
            if photo.stage is not None
            else None
        )
        return PhotoResponse(
            id=photo.id,
            plant_id=photo.plant_id,
            journal_entry_id=photo.journal_entry_id,
            measurement_id=photo.measurement_id,
            stage=stage,
            caption=photo.caption,
            tags=list(photo.tags),
            content_type=photo.content_type,
            file_size=photo.file_size,
            occurred_at=photo.occurred_at,
            created_at=photo.created_at,
            updated_at=photo.updated_at,
        )

    async def get_plant_timeline(
        self, plant_id: str, *, limit: int = 50, offset: int = 0
    ) -> TimelineListResponse:
        async with self._database.transaction() as session:
            repository = JournalRepository(session)
            if await repository.get_plant(plant_id) is None:
                raise JournalNotFound("Plant was not found")

            items: list[TimelineEntryResponse] = []
            for entry in await repository.list_entries("plant", plant_id):
                items.append(
                    TimelineEntryResponse(
                        id=f"journal_entry:{entry.id}",
                        event_type=entry.entry_type,
                        occurred_at=entry.occurred_at,
                        summary=entry.title or entry.entry_type.replace("_", " ").capitalize(),
                        journal_entry=self._response(entry),
                    )
                )
            for measurement in await repository.list_measurements(plant_id):
                items.append(
                    TimelineEntryResponse(
                        id=f"measurement:{measurement.id}",
                        event_type="measurement_recorded",
                        occurred_at=measurement.occurred_at,
                        summary=self._measurement_summary(measurement),
                        measurement=self._measurement_response(measurement),
                    )
                )
            for photo in await repository.list_photos(plant_id):
                items.append(
                    TimelineEntryResponse(
                        id=f"photo:{photo.id}",
                        event_type="photo_added",
                        occurred_at=photo.occurred_at,
                        summary=photo.caption or "Photo added",
                        photo=self._photo_response(photo),
                    )
                )
            for transition in await repository.list_transitions(plant_id):
                items.append(
                    TimelineEntryResponse(
                        id=f"stage_transition:{transition.id}",
                        event_type="stage_changed",
                        occurred_at=transition.effective_at,
                        summary=self._transition_summary(transition),
                        stage_transition=self._transition_response(transition),
                    )
                )

        items.sort(key=lambda item: item.occurred_at, reverse=True)
        return TimelineListResponse(items=items[offset : offset + limit])

    @staticmethod
    def _measurement_summary(measurement: Measurement) -> str:
        label = (
            measurement.custom_metric_name
            if measurement.metric_type == MeasurementMetric.CUSTOM.value
            else measurement.metric_type.replace("_", " ").capitalize()
        )
        value = measurement.value
        formatted_value = f"{value:g}"
        return f"{label}: {formatted_value} {measurement.unit}"

    @staticmethod
    def _transition_summary(transition: PlantStageTransition) -> str:
        to_label = transition.to_stage.label
        if transition.from_stage is None:
            return f"→ {to_label}"
        return f"{transition.from_stage.label} → {to_label}"

    @staticmethod
    def _transition_response(transition: PlantStageTransition) -> TimelineStageTransition:
        from_stage = (
            CompactStageRef.model_validate(transition.from_stage, from_attributes=True)
            if transition.from_stage is not None
            else None
        )
        return TimelineStageTransition(
            id=transition.id,
            from_stage=from_stage,
            to_stage=CompactStageRef.model_validate(transition.to_stage, from_attributes=True),
            effective_at=transition.effective_at,
            source=transition.source,
            notes=transition.notes,
            created_at=transition.created_at,
        )

    async def _create_entry(
        self,
        repository: JournalRepository,
        subject_type: JournalSubjectType,
        subject_id: str,
        request: JournalEntryCreate,
    ) -> JournalEntry:
        if request.related_stage_id is not None:
            if await repository.get_stage(request.related_stage_id) is None:
                raise JournalNotFound("Lifecycle stage was not found")
        entry = JournalEntry(
            subject_type=subject_type.value,
            subject_id=subject_id,
            entry_type=request.entry_type.value,
            occurred_at=request.occurred_at or default_occurred_at(),
            title=request.title,
            notes=request.notes,
            tags=list(request.tags),
            related_stage_id=request.related_stage_id,
            related_issue=request.related_issue,
        )
        return await repository.add_entry(entry)

    @staticmethod
    def _apply_update(entry: JournalEntry, request: JournalEntryUpdate) -> None:
        if request.entry_type is not None:
            entry.entry_type = request.entry_type.value
        if request.occurred_at is not None:
            entry.occurred_at = request.occurred_at
        if "title" in request.model_fields_set:
            entry.title = request.title
        if "notes" in request.model_fields_set:
            entry.notes = request.notes
        if request.tags is not None:
            entry.tags = list(request.tags)
        if "related_stage_id" in request.model_fields_set:
            entry.related_stage_id = request.related_stage_id
        if "related_issue" in request.model_fields_set:
            entry.related_issue = request.related_issue

    @staticmethod
    def _response(entry: JournalEntry) -> JournalEntryResponse:
        related_stage = (
            CompactStageRef.model_validate(entry.related_stage, from_attributes=True)
            if entry.related_stage is not None
            else None
        )
        return JournalEntryResponse(
            id=entry.id,
            subject_type=JournalSubjectType(entry.subject_type),
            subject_id=entry.subject_id,
            entry_type=entry.entry_type,
            occurred_at=entry.occurred_at,
            title=entry.title,
            notes=entry.notes,
            tags=list(entry.tags),
            related_stage=related_stage,
            related_issue=entry.related_issue,
            created_at=entry.created_at,
            updated_at=entry.updated_at,
        )
