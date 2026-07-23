"""Transactional application service for grow spaces and mappings."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import AuditLog, EntityMapping, GrowSpace
from cultivation_assistant.grow_spaces.discovery import EntityDiscoveryService
from cultivation_assistant.grow_spaces.repository import GrowSpaceRepository
from cultivation_assistant.grow_spaces.roles import get_role_definition
from cultivation_assistant.grow_spaces.schemas import (
    EntityMappingCreate,
    EntityMappingResponse,
    EntityMappingUpdate,
    GrowSpaceCreate,
    GrowSpaceListResponse,
    GrowSpaceResponse,
    GrowSpaceSummary,
    GrowSpaceUpdate,
    LiveReading,
)
from cultivation_assistant.grow_spaces.units import (
    Compatibility,
    normalize_area,
    normalize_environment_value,
    normalize_volume,
)
from cultivation_assistant.home_assistant.state_cache import EntityStateCache


class GrowSpaceNotFound(RuntimeError):
    """Raised when a grow space or nested resource does not exist."""


class GrowSpaceConflict(RuntimeError):
    """Raised when a requested change conflicts with current configuration."""


class GrowSpaceValidationError(RuntimeError):
    """Raised when domain validation rejects a requested change."""


class GrowSpaceService:
    """Apply grow-space policy inside explicit database transactions."""

    def __init__(self, database: Database, state_cache: EntityStateCache) -> None:
        self._database = database
        self._state_cache = state_cache
        self._discovery = EntityDiscoveryService(state_cache)

    async def list_spaces(self, *, include_archived: bool = False) -> GrowSpaceListResponse:
        async with self._database.transaction() as session:
            records = await GrowSpaceRepository(session).list(include_archived=include_archived)
            return GrowSpaceListResponse(items=[self._summary(item) for item in records])

    async def get(self, grow_space_id: str) -> GrowSpaceResponse:
        async with self._database.transaction() as session:
            record = await GrowSpaceRepository(session).get(grow_space_id)
            if record is None:
                raise GrowSpaceNotFound("Grow space was not found")
            return self._response(record)

    async def create(
        self,
        request: GrowSpaceCreate,
        correlation_id: str,
    ) -> GrowSpaceResponse:
        async with self._database.transaction() as session:
            repository = GrowSpaceRepository(session)
            if await repository.active_name_exists(request.name):
                raise GrowSpaceConflict("An active grow space with this name already exists")
            record = await repository.add(request)
            created_mappings: list[EntityMapping] = []
            for mapping_request in request.mappings:
                created_mappings.append(
                    await self._add_mapping_record(repository, record, mapping_request)
                )
            session.add(
                self._audit(
                    action="grow_space.created",
                    resource_type="grow_space",
                    resource_id=record.id,
                    correlation_id=correlation_id,
                    details={
                        "name": record.name,
                        "mapping_count": len(created_mappings),
                    },
                )
            )
            await session.flush()
            return self._response(record, mappings=created_mappings)

    async def update(
        self,
        grow_space_id: str,
        request: GrowSpaceUpdate,
        correlation_id: str,
    ) -> GrowSpaceResponse:
        async with self._database.transaction() as session:
            repository = GrowSpaceRepository(session)
            record = await self._require_space(repository, grow_space_id)
            self._require_active(record)
            if request.name is not None and await repository.active_name_exists(
                request.name,
                exclude_id=record.id,
            ):
                raise GrowSpaceConflict("An active grow space with this name already exists")

            changed = self._apply_update(record, request)
            session.add(
                self._audit(
                    action="grow_space.updated",
                    resource_type="grow_space",
                    resource_id=record.id,
                    correlation_id=correlation_id,
                    details={"changed_fields": sorted(changed)},
                )
            )
            await session.flush()
            return self._response(record)

    async def archive(self, grow_space_id: str, correlation_id: str) -> None:
        async with self._database.transaction() as session:
            repository = GrowSpaceRepository(session)
            record = await self._require_space(repository, grow_space_id)
            self._require_active(record)
            record.active = False
            record.updated_at = datetime.now(UTC)
            session.add(
                self._audit(
                    action="grow_space.archived",
                    resource_type="grow_space",
                    resource_id=record.id,
                    correlation_id=correlation_id,
                    details={"name": record.name},
                )
            )
            await session.flush()

    async def create_mapping(
        self,
        grow_space_id: str,
        request: EntityMappingCreate,
        correlation_id: str,
    ) -> EntityMappingResponse:
        async with self._database.transaction() as session:
            repository = GrowSpaceRepository(session)
            grow_space = await self._require_space(repository, grow_space_id)
            self._require_active(grow_space)
            mapping = await self._add_mapping_record(repository, grow_space, request)
            session.add(
                self._audit(
                    action="entity_mapping.created",
                    resource_type="entity_mapping",
                    resource_id=mapping.id,
                    correlation_id=correlation_id,
                    details={
                        "grow_space_id": grow_space.id,
                        "entity_id": mapping.entity_id,
                        "role": mapping.role,
                    },
                )
            )
            await session.flush()
            return self._mapping(mapping)

    async def update_mapping(
        self,
        grow_space_id: str,
        mapping_id: str,
        request: EntityMappingUpdate,
        correlation_id: str,
    ) -> EntityMappingResponse:
        async with self._database.transaction() as session:
            repository = GrowSpaceRepository(session)
            grow_space = await self._require_space(repository, grow_space_id)
            self._require_active(grow_space)
            mapping = await repository.get_mapping(grow_space_id, mapping_id)
            if mapping is None:
                raise GrowSpaceNotFound("Entity mapping was not found")
            changed = self._apply_mapping_update(mapping, request)
            session.add(
                self._audit(
                    action="entity_mapping.updated",
                    resource_type="entity_mapping",
                    resource_id=mapping.id,
                    correlation_id=correlation_id,
                    details={
                        "grow_space_id": grow_space.id,
                        "changed_fields": sorted(changed),
                    },
                )
            )
            await session.flush()
            return self._mapping(mapping)

    async def delete_mapping(
        self,
        grow_space_id: str,
        mapping_id: str,
        correlation_id: str,
    ) -> None:
        async with self._database.transaction() as session:
            repository = GrowSpaceRepository(session)
            grow_space = await self._require_space(repository, grow_space_id)
            self._require_active(grow_space)
            mapping = await repository.get_mapping(grow_space_id, mapping_id)
            if mapping is None:
                raise GrowSpaceNotFound("Entity mapping was not found")
            details = {
                "grow_space_id": grow_space.id,
                "entity_id": mapping.entity_id,
                "role": mapping.role,
            }
            await repository.delete_mapping(mapping)
            session.add(
                self._audit(
                    action="entity_mapping.deleted",
                    resource_type="entity_mapping",
                    resource_id=mapping_id,
                    correlation_id=correlation_id,
                    details=details,
                )
            )

    async def _add_mapping_record(
        self,
        repository: GrowSpaceRepository,
        grow_space: GrowSpace,
        request: EntityMappingCreate,
    ) -> EntityMapping:
        if await repository.mapping_exists(
            grow_space.id,
            request.entity_id,
            request.role,
        ):
            raise GrowSpaceConflict("This entity is already mapped to this role")
        source_unit, normalized_unit = self._mapping_units(request)
        return await repository.add_mapping(
            grow_space,
            request,
            source_unit=source_unit,
            normalized_unit=normalized_unit,
        )

    def _mapping_units(self, request: EntityMappingCreate) -> tuple[str | None, str | None]:
        definition = get_role_definition(request.role)
        state = self._state_cache.find(request.entity_id)
        if state is None:
            return None, definition.canonical_unit
        candidate = self._discovery.assess(state, request.role)
        if candidate is None:
            raise GrowSpaceValidationError(
                f"Entity {request.entity_id} is incompatible with role {request.role}"
            )
        return candidate.source_unit, definition.canonical_unit

    @staticmethod
    async def _require_space(
        repository: GrowSpaceRepository,
        grow_space_id: str,
    ) -> GrowSpace:
        record = await repository.get(grow_space_id)
        if record is None:
            raise GrowSpaceNotFound("Grow space was not found")
        return record

    @staticmethod
    def _require_active(record: GrowSpace) -> None:
        if not record.active:
            raise GrowSpaceConflict("Archived grow spaces cannot be changed")

    @staticmethod
    def _apply_update(record: GrowSpace, request: GrowSpaceUpdate) -> set[str]:
        changed: set[str] = set()
        fields = request.model_fields_set
        if "name" in fields and request.name is not None:
            record.name = request.name
            changed.add("name")
        if "description" in fields:
            record.description = request.description
            changed.add("description")
        if "location" in fields:
            record.location = request.location
            changed.add("location")
        if "space_type" in fields and request.space_type is not None:
            record.space_type = request.space_type.value
            changed.add("space_type")
        if "area" in fields:
            record.area_m2 = (
                None
                if request.area is None
                else normalize_area(request.area.value, request.area.unit)
            )
            changed.add("area_m2")
        if "volume" in fields:
            record.volume_m3 = (
                None
                if request.volume is None
                else normalize_volume(request.volume.value, request.volume.unit)
            )
            changed.add("volume_m3")
        if changed:
            record.updated_at = datetime.now(UTC)
        return changed

    @staticmethod
    def _apply_mapping_update(
        mapping: EntityMapping,
        request: EntityMappingUpdate,
    ) -> set[str]:
        changed: set[str] = set()
        fields = request.model_fields_set
        for field_name in (
            "display_name",
            "priority",
            "enabled",
            "calibration",
            "stale_after_seconds",
        ):
            if field_name in fields:
                setattr(mapping, field_name, getattr(request, field_name))
                changed.add(field_name)
        if changed:
            mapping.updated_at = datetime.now(UTC)
        return changed

    @staticmethod
    def _audit(
        *,
        action: str,
        resource_type: str,
        resource_id: str,
        correlation_id: str,
        details: dict[str, Any],
    ) -> AuditLog:
        return AuditLog(
            occurred_at=datetime.now(UTC),
            actor="local_user",
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            correlation_id=correlation_id or None,
            details=details,
        )

    def _mapping(self, record: EntityMapping) -> EntityMappingResponse:
        response = EntityMappingResponse.model_validate(record)
        state = self._state_cache.find(record.entity_id)
        if state is None:
            return response
        candidate = self._discovery.assess(state, record.role)
        if candidate is None:
            return response.model_copy(
                update={
                    "compatibility": Compatibility.INCOMPATIBLE,
                    "compatibility_explanation": (
                        "Current Home Assistant metadata is incompatible with this role."
                    ),
                }
            )
        return response.model_copy(
            update={
                "compatibility": candidate.compatibility,
                "compatibility_explanation": candidate.explanation,
            }
        )

    def _live_readings(self, mappings: list[EntityMapping]) -> list[LiveReading]:
        readings: list[LiveReading] = []
        for mapping in sorted(mappings, key=lambda item: (item.role, item.priority)):
            if not mapping.enabled:
                continue
            state = self._state_cache.find(mapping.entity_id)
            if state is None:
                continue
            available = state.state.casefold() not in {"unknown", "unavailable"}
            normalized_value: Decimal | bool | None = None
            if available:
                if mapping.role == "leak_detection":
                    normalized_value = state.state.casefold() in {
                        "on",
                        "true",
                        "wet",
                        "detected",
                    }
                elif mapping.source_unit is not None:
                    try:
                        normalized_value = normalize_environment_value(
                            mapping.role,
                            Decimal(state.state),
                            mapping.source_unit,
                        )
                    except (InvalidOperation, ValueError):
                        normalized_value = None
            readings.append(
                LiveReading(
                    entity_id=mapping.entity_id,
                    role=mapping.role,
                    raw_value=state.state,
                    normalized_value=normalized_value,
                    normalized_unit=mapping.normalized_unit,
                    last_updated=state.last_updated,
                    stale=self._state_cache.is_stale(
                        mapping.entity_id,
                        timedelta(seconds=mapping.stale_after_seconds),
                    ),
                    available=available,
                )
            )
        return readings

    def _summary(
        self,
        record: GrowSpace,
        *,
        mapping_count: int | None = None,
        mappings: list[EntityMapping] | None = None,
    ) -> GrowSpaceSummary:
        selected_mappings = record.mappings if mappings is None else mappings
        return GrowSpaceSummary(
            id=record.id,
            name=record.name,
            description=record.description,
            location=record.location,
            space_type=record.space_type,
            active=record.active,
            area_m2=record.area_m2,
            volume_m3=record.volume_m3,
            mapping_count=(len(selected_mappings) if mapping_count is None else mapping_count),
            live_readings=self._live_readings(selected_mappings),
            created_at=record.created_at,
            updated_at=record.updated_at,
        )

    def _response(
        self,
        record: GrowSpace,
        *,
        mappings: list[EntityMapping] | None = None,
    ) -> GrowSpaceResponse:
        selected_mappings = record.mappings if mappings is None else mappings
        summary = self._summary(
            record,
            mapping_count=len(selected_mappings),
            mappings=selected_mappings,
        )
        return GrowSpaceResponse(
            **summary.model_dump(),
            mappings=[self._mapping(item) for item in selected_mappings],
        )
