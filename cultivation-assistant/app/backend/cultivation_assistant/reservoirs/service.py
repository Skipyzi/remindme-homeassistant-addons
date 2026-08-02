"""Transactional application service for reservoirs."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation

from cultivation_assistant.audit import audit_record
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import (
    Reservoir,
    ReservoirCalibrationPoint,
    ReservoirEntityMapping,
)
from cultivation_assistant.grow_spaces.dimensions import DimensionUnit, from_metres, to_metres
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.reservoirs.discovery import EntityDiscoveryService
from cultivation_assistant.reservoirs.geometry import GeometryShape
from cultivation_assistant.reservoirs.repository import ReservoirRepository
from cultivation_assistant.reservoirs.roles import get_role_definition
from cultivation_assistant.reservoirs.schemas import (
    CalibrationPointListResponse,
    CalibrationPointResponse,
    CalibrationPointsReplace,
    EntityDiscoveryResponse,
    GeometryInput,
    GeometryResponse,
    LiveReading,
    ReservoirCreate,
    ReservoirListResponse,
    ReservoirMappingCreate,
    ReservoirMappingResponse,
    ReservoirMappingUpdate,
    ReservoirResponse,
    ReservoirSummary,
    ReservoirUpdate,
)
from cultivation_assistant.reservoirs.units import (
    Compatibility,
    binary_state_value,
    is_binary_reservoir_role,
    normalize_reservoir_value,
)


class ReservoirNotFound(RuntimeError):
    """Raised when a reservoir does not exist."""


class ReservoirConflict(RuntimeError):
    """Raised when a requested identity already exists."""


class ReservoirValidationError(RuntimeError):
    """Raised when domain validation rejects a requested change."""


class ReservoirService:
    """Apply reservoir policy inside explicit transactions."""

    def __init__(self, database: Database, state_cache: EntityStateCache) -> None:
        self._database = database
        self._state_cache = state_cache
        self._discovery = EntityDiscoveryService(state_cache)

    async def list_reservoirs(self, *, include_archived: bool = False) -> ReservoirListResponse:
        async with self._database.transaction() as session:
            records = await ReservoirRepository(session).list_reservoirs(
                include_archived=include_archived
            )
            return ReservoirListResponse(items=[self._summary(record) for record in records])

    async def get(self, reservoir_id: str) -> ReservoirResponse:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            record = await self._require_reservoir(repository, reservoir_id)
            return self._response(record)

    async def create(self, request: ReservoirCreate, correlation_id: str) -> ReservoirResponse:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            if await repository.active_name_exists(request.name):
                raise ReservoirConflict("An active reservoir with this name already exists")
            if (
                request.primary_grow_space_id is not None
                and await repository.get_grow_space(request.primary_grow_space_id) is None
            ):
                raise ReservoirNotFound("Grow space was not found")

            canonical = self._canonical_geometry(request.geometry)
            record = Reservoir(
                name=request.name,
                reservoir_type=request.reservoir_type.value,
                primary_grow_space_id=request.primary_grow_space_id,
                capacity_liters=request.capacity_liters,
                usable_capacity_liters=request.usable_capacity_liters,
                minimum_safe_volume_liters=request.minimum_safe_volume_liters,
                refill_threshold_liters=request.refill_threshold_liters,
                overflow_threshold_liters=request.overflow_threshold_liters,
                geometry_shape=request.geometry.shape.value,
                geometry_unit=(
                    request.geometry.unit.value if request.geometry.unit is not None else None
                ),
                **canonical,
            )
            await repository.add(record)
            session.add(
                audit_record(
                    "reservoir.created",
                    "reservoir",
                    record.id,
                    correlation_id,
                    details={"name": record.name, "reservoir_type": record.reservoir_type},
                )
            )
            await session.flush()
            await session.refresh(record, attribute_names=["entity_mappings"])
            return self._response(record)

    async def update(
        self, reservoir_id: str, request: ReservoirUpdate, correlation_id: str
    ) -> ReservoirResponse:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            record = await self._require_reservoir(repository, reservoir_id)
            old_active = record.active

            resulting_name = request.name if request.name is not None else record.name
            resulting_active = request.active if request.active is not None else record.active
            if resulting_active and await repository.active_name_exists(
                resulting_name, exclude_id=record.id
            ):
                raise ReservoirConflict("An active reservoir with this name already exists")

            resulting_capacity = (
                request.capacity_liters
                if request.capacity_liters is not None
                else record.capacity_liters
            )
            resulting_usable = (
                request.usable_capacity_liters
                if "usable_capacity_liters" in request.model_fields_set
                else record.usable_capacity_liters
            )
            if resulting_usable is not None and resulting_usable > resulting_capacity:
                raise ReservoirValidationError("Usable capacity cannot exceed capacity")

            if (
                "primary_grow_space_id" in request.model_fields_set
                and request.primary_grow_space_id is not None
                and await repository.get_grow_space(request.primary_grow_space_id) is None
            ):
                raise ReservoirNotFound("Grow space was not found")

            changed = self._apply_update(record, request)
            if old_active and not record.active:
                action = "reservoir.deactivated"
            elif not old_active and record.active:
                action = "reservoir.reactivated"
            else:
                action = "reservoir.updated"
            session.add(
                audit_record(
                    action,
                    "reservoir",
                    record.id,
                    correlation_id,
                    details={"changed_fields": sorted(changed)},
                )
            )
            await session.flush()
            return self._response(record)

    async def archive(self, reservoir_id: str, correlation_id: str) -> None:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            record = await self._require_reservoir(repository, reservoir_id)
            if record.active:
                record.active = False
                record.updated_at = datetime.now(UTC)
                session.add(
                    audit_record(
                        "reservoir.deactivated",
                        "reservoir",
                        record.id,
                        correlation_id,
                        details={"name": record.name},
                    )
                )

    async def list_calibration_points(self, reservoir_id: str) -> CalibrationPointListResponse:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            await self._require_reservoir(repository, reservoir_id)
            points = await repository.list_calibration_points(reservoir_id)
            return CalibrationPointListResponse(
                items=[self._calibration_response(point) for point in points]
            )

    async def replace_calibration_points(
        self, reservoir_id: str, request: CalibrationPointsReplace, correlation_id: str
    ) -> CalibrationPointListResponse:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            await self._require_reservoir(repository, reservoir_id)
            points = await repository.replace_calibration_points(
                reservoir_id,
                [(point.raw_value, point.volume_liters) for point in request.points],
            )
            session.add(
                audit_record(
                    "reservoir.calibration_replaced",
                    "reservoir",
                    reservoir_id,
                    correlation_id,
                    details={"point_count": len(points)},
                )
            )
            return CalibrationPointListResponse(
                items=[self._calibration_response(point) for point in points]
            )

    async def suggest_entities(self, role: str) -> EntityDiscoveryResponse:
        """Return deterministic compatible Home Assistant suggestions for one role."""
        return EntityDiscoveryResponse(items=self._discovery.suggest(role))

    async def create_mapping(
        self,
        reservoir_id: str,
        request: ReservoirMappingCreate,
        correlation_id: str,
    ) -> ReservoirMappingResponse:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            reservoir = await self._require_reservoir(repository, reservoir_id)
            mapping = await self._add_mapping_record(repository, reservoir, request)
            session.add(
                audit_record(
                    "reservoir_entity_mapping.created",
                    "reservoir_entity_mapping",
                    mapping.id,
                    correlation_id,
                    details={
                        "reservoir_id": reservoir.id,
                        "entity_id": mapping.entity_id,
                        "role": mapping.role,
                    },
                )
            )
            await session.flush()
            return self._mapping(mapping)

    async def update_mapping(
        self,
        reservoir_id: str,
        mapping_id: str,
        request: ReservoirMappingUpdate,
        correlation_id: str,
    ) -> ReservoirMappingResponse:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            mapping = await self._require_reservoir_mapping(repository, reservoir_id, mapping_id)
            changed = self._apply_mapping_update(mapping, request)
            session.add(
                audit_record(
                    "reservoir_entity_mapping.updated",
                    "reservoir_entity_mapping",
                    mapping.id,
                    correlation_id,
                    details={"reservoir_id": reservoir_id, "changed_fields": sorted(changed)},
                )
            )
            await session.flush()
            return self._mapping(mapping)

    async def delete_mapping(
        self,
        reservoir_id: str,
        mapping_id: str,
        correlation_id: str,
    ) -> None:
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            mapping = await self._require_reservoir_mapping(repository, reservoir_id, mapping_id)
            await repository.delete_mapping(mapping)
            session.add(
                audit_record(
                    "reservoir_entity_mapping.deleted",
                    "reservoir_entity_mapping",
                    mapping_id,
                    correlation_id,
                    details={
                        "reservoir_id": reservoir_id,
                        "entity_id": mapping.entity_id,
                        "role": mapping.role,
                    },
                )
            )

    async def _add_mapping_record(
        self,
        repository: ReservoirRepository,
        reservoir: Reservoir,
        request: ReservoirMappingCreate,
    ) -> ReservoirEntityMapping:
        if await repository.mapping_exists(reservoir.id, request.entity_id, request.role):
            raise ReservoirConflict("This entity is already mapped to this role")
        source_unit, normalized_unit = self._mapping_units(request)
        return await repository.add_mapping(
            reservoir,
            request,
            source_unit=source_unit,
            normalized_unit=normalized_unit,
        )

    def _mapping_units(
        self, request: ReservoirMappingCreate
    ) -> tuple[str | None, str | None]:
        """Derive persisted units from the live cache, rejecting incompatible entities."""
        definition = get_role_definition(request.role)
        state = self._state_cache.find(request.entity_id)
        if state is None:
            return None, definition.canonical_unit
        candidate = self._discovery.assess(state, request.role)
        if candidate is None:
            raise ReservoirValidationError(
                f"Entity {request.entity_id} is incompatible with role {request.role}"
            )
        return candidate.source_unit, definition.canonical_unit

    def _mapping(self, record: ReservoirEntityMapping) -> ReservoirMappingResponse:
        """Build a mapping response with a live-cache compatibility overlay."""
        response = ReservoirMappingResponse.model_validate(record)
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

    def _live_readings(self, mappings: list[ReservoirEntityMapping]) -> list[LiveReading]:
        """Derive normalized live readings from the Home Assistant state cache."""
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
                if is_binary_reservoir_role(mapping.role):
                    normalized_value = binary_state_value(state.state)
                elif mapping.source_unit is not None:
                    try:
                        normalized_value = normalize_reservoir_value(
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

    @staticmethod
    def _apply_mapping_update(
        mapping: ReservoirEntityMapping,
        request: ReservoirMappingUpdate,
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
    async def _require_reservoir_mapping(
        repository: ReservoirRepository,
        reservoir_id: str,
        mapping_id: str,
    ) -> ReservoirEntityMapping:
        mapping = await repository.get_mapping(reservoir_id, mapping_id)
        if mapping is None:
            raise ReservoirNotFound("Reservoir mapping was not found")
        return mapping

    @staticmethod
    def _calibration_response(point: ReservoirCalibrationPoint) -> CalibrationPointResponse:
        return CalibrationPointResponse(
            id=point.id,
            reservoir_id=point.reservoir_id,
            raw_value=point.raw_value,
            volume_liters=point.volume_liters,
        )

    @staticmethod
    async def _require_reservoir(
        repository: ReservoirRepository, reservoir_id: str
    ) -> Reservoir:
        record = await repository.get(reservoir_id)
        if record is None:
            raise ReservoirNotFound("Reservoir was not found")
        return record

    @staticmethod
    def _canonical_geometry(geometry: GeometryInput) -> dict[str, Decimal | None]:
        if geometry.shape is GeometryShape.CUSTOM_CALIBRATION_TABLE or geometry.unit is None:
            return {
                "geometry_length_m": None,
                "geometry_width_m": None,
                "geometry_height_m": None,
                "geometry_diameter_m": None,
            }

        def convert(value: Decimal | None) -> Decimal | None:
            assert geometry.unit is not None
            return None if value is None else to_metres(value, geometry.unit)

        return {
            "geometry_length_m": convert(geometry.length),
            "geometry_width_m": convert(geometry.width),
            "geometry_height_m": convert(geometry.height),
            "geometry_diameter_m": convert(geometry.diameter),
        }

    def _apply_update(self, record: Reservoir, request: ReservoirUpdate) -> set[str]:
        changed: set[str] = set()
        if request.name is not None and request.name != record.name:
            record.name = request.name
            changed.add("name")
        if request.reservoir_type is not None:
            record.reservoir_type = request.reservoir_type.value
            changed.add("reservoir_type")
        if "primary_grow_space_id" in request.model_fields_set:
            record.primary_grow_space_id = request.primary_grow_space_id
            changed.add("primary_grow_space_id")
        if request.capacity_liters is not None:
            record.capacity_liters = request.capacity_liters
            changed.add("capacity_liters")
        if "usable_capacity_liters" in request.model_fields_set:
            record.usable_capacity_liters = request.usable_capacity_liters
            changed.add("usable_capacity_liters")
        if "minimum_safe_volume_liters" in request.model_fields_set:
            record.minimum_safe_volume_liters = request.minimum_safe_volume_liters
            changed.add("minimum_safe_volume_liters")
        if "refill_threshold_liters" in request.model_fields_set:
            record.refill_threshold_liters = request.refill_threshold_liters
            changed.add("refill_threshold_liters")
        if "overflow_threshold_liters" in request.model_fields_set:
            record.overflow_threshold_liters = request.overflow_threshold_liters
            changed.add("overflow_threshold_liters")
        if request.geometry is not None:
            record.geometry_shape = request.geometry.shape.value
            record.geometry_unit = (
                request.geometry.unit.value if request.geometry.unit is not None else None
            )
            canonical = self._canonical_geometry(request.geometry)
            record.geometry_length_m = canonical["geometry_length_m"]
            record.geometry_width_m = canonical["geometry_width_m"]
            record.geometry_height_m = canonical["geometry_height_m"]
            record.geometry_diameter_m = canonical["geometry_diameter_m"]
            changed.add("geometry")
        if request.active is not None:
            record.active = request.active
            changed.add("active")
        record.updated_at = datetime.now(UTC)
        return changed

    @staticmethod
    def _geometry_response(record: Reservoir) -> GeometryResponse:
        shape = GeometryShape(record.geometry_shape)
        if shape is GeometryShape.CUSTOM_CALIBRATION_TABLE or record.geometry_unit is None:
            return GeometryResponse(
                shape=shape, unit=None, length=None, width=None, height=None, diameter=None
            )
        unit = DimensionUnit(record.geometry_unit)

        def convert(value: Decimal | None) -> Decimal | None:
            return None if value is None else from_metres(value, unit)

        return GeometryResponse(
            shape=shape,
            unit=unit,
            length=convert(record.geometry_length_m),
            width=convert(record.geometry_width_m),
            height=convert(record.geometry_height_m),
            diameter=convert(record.geometry_diameter_m),
        )

    def _summary(self, record: Reservoir) -> ReservoirSummary:
        mappings = list(record.entity_mappings)
        return ReservoirSummary(
            id=record.id,
            name=record.name,
            reservoir_type=record.reservoir_type,
            primary_grow_space_id=record.primary_grow_space_id,
            capacity_liters=record.capacity_liters,
            usable_capacity_liters=record.usable_capacity_liters,
            active=record.active,
            geometry=self._geometry_response(record),
            mapping_count=len(mappings),
            live_readings=self._live_readings(mappings),
            created_at=record.created_at,
            updated_at=record.updated_at,
        )

    def _response(self, record: Reservoir) -> ReservoirResponse:
        mappings = [self._mapping(mapping) for mapping in record.entity_mappings]
        return ReservoirResponse(
            **self._summary(record).model_dump(),
            minimum_safe_volume_liters=record.minimum_safe_volume_liters,
            refill_threshold_liters=record.refill_threshold_liters,
            overflow_threshold_liters=record.overflow_threshold_liters,
            mappings=mappings,
        )
