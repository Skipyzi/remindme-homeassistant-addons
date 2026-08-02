"""Transactional application service for Plants and stage transitions."""

from datetime import UTC, datetime, time

from cultivation_assistant.audit import audit_record
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import (
    Cultivar,
    Grow,
    GrowSpace,
    LifecycleStage,
    Plant,
    PlantStageTransition,
)
from cultivation_assistant.lifecycle.rules import (
    PlantStatus,
    PropagationSource,
    SeedType,
    TransitionOrder,
    TransitionSource,
    ordered_current_stage,
    requires_transition_confirmation,
)
from cultivation_assistant.plants.repository import PlantRepository
from cultivation_assistant.plants.schemas import (
    CompactCultivar,
    CompactRef,
    CompactStage,
    PlantCreate,
    PlantListResponse,
    PlantResponse,
    PlantStageTransitionCreate,
    PlantStageTransitionResult,
    PlantSummary,
    PlantUpdate,
    TransitionResponse,
)

_STATUS_REQUIRES_START = {
    PlantStatus.ACTIVE,
    PlantStatus.HARVESTED,
    PlantStatus.COMPLETED,
    PlantStatus.LOST,
}
_HARVEST_STATUSES = {PlantStatus.HARVESTED, PlantStatus.COMPLETED}


class PlantNotFound(RuntimeError):
    """Raised when a Plant or a required related record does not exist."""


class PlantConflict(RuntimeError):
    """Raised when a Plant name conflicts within a Grow."""


class PlantValidationError(RuntimeError):
    """Raised when domain validation rejects a Plant change."""


class PlantTransitionConfirmationRequired(RuntimeError):
    """Raised when a backward or skipped transition lacks explicit confirmation."""


class PlantService:
    """Apply Plant policy inside explicit database transactions."""

    def __init__(self, database: Database) -> None:
        self._database = database

    async def list_plants(
        self,
        *,
        grow_id: str | None = None,
        grow_space_id: str | None = None,
        statuses: list[str] | None = None,
        stage_id: str | None = None,
        query: str | None = None,
        include_archived: bool = False,
    ) -> PlantListResponse:
        async with self._database.transaction() as session:
            plants = await PlantRepository(session).list_plants(
                grow_id=grow_id,
                grow_space_id=grow_space_id,
                statuses=statuses,
                stage_id=stage_id,
                query=query,
                include_archived=include_archived,
            )
            return PlantListResponse(items=[self._summary(plant) for plant in plants])

    async def get(self, plant_id: str) -> PlantResponse:
        async with self._database.transaction() as session:
            repository = PlantRepository(session)
            plant = await repository.get_plant(plant_id)
            if plant is None:
                raise PlantNotFound("Plant was not found")
            return await self._response(repository, plant)

    async def create(self, request: PlantCreate, correlation_id: str) -> PlantResponse:
        async with self._database.transaction() as session:
            repository = PlantRepository(session)
            grow = await repository.get_grow(request.grow_id)
            if grow is None:
                raise PlantNotFound("Grow was not found")
            cultivar = await repository.get_cultivar(request.cultivar_id)
            if cultivar is None:
                raise PlantNotFound("Cultivar was not found")
            if not cultivar.active:
                raise PlantValidationError("The selected cultivar is inactive")
            stage = await repository.get_stage(request.current_stage_id)
            if stage is None:
                raise PlantNotFound("Lifecycle stage was not found")
            if not stage.enabled:
                raise PlantValidationError("The initial lifecycle stage is disabled")
            if await repository.active_name_exists(request.grow_id, request.name):
                raise PlantConflict("A Plant with this name already exists in this Grow")

            plant = Plant(
                grow_id=request.grow_id,
                cultivar_id=request.cultivar_id,
                name=request.name,
                propagation_source=request.propagation_source.value,
                seed_type=request.seed_type.value if request.seed_type is not None else None,
                start_date=request.start_date,
                current_stage_id=request.current_stage_id,
                status=request.status.value,
                container=request.container,
                medium=request.medium,
                location=request.location,
                expected_harvest_start=request.expected_harvest_start,
                expected_harvest_end=request.expected_harvest_end,
                actual_harvest_date=request.actual_harvest_date,
                notes=request.notes,
            )
            await repository.add_plant(plant)
            transition = repository.build_transition(
                plant.id,
                None,
                request.current_stage_id,
                self._initial_effective_at(request.start_date),
                TransitionSource.USER_CONFIRMED.value,
                None,
            )
            await repository.add_transition(transition)
            session.add(
                audit_record(
                    "plant.created",
                    "plant",
                    plant.id,
                    correlation_id,
                    details={"name": plant.name, "grow_id": plant.grow_id},
                )
            )
            await session.flush()
            refreshed = await repository.get_plant(plant.id)
            assert refreshed is not None
            return await self._response(repository, refreshed)

    async def update(
        self, plant_id: str, request: PlantUpdate, correlation_id: str
    ) -> PlantResponse:
        async with self._database.transaction() as session:
            repository = PlantRepository(session)
            plant = await repository.get_plant(plant_id)
            if plant is None:
                raise PlantNotFound("Plant was not found")
            was_archived = plant.status == PlantStatus.ARCHIVED.value

            resulting_name = request.name if request.name is not None else plant.name
            resulting_status = (
                request.status.value if request.status is not None else plant.status
            )
            resulting_start = (
                request.start_date
                if "start_date" in request.model_fields_set
                else plant.start_date
            )
            resulting_harvest = (
                request.actual_harvest_date
                if "actual_harvest_date" in request.model_fields_set
                else plant.actual_harvest_date
            )
            self._validate_state(resulting_status, resulting_start, resulting_harvest)
            if (
                resulting_status != PlantStatus.ARCHIVED.value
                and request.name is not None
                and await repository.active_name_exists(
                    plant.grow_id, resulting_name, exclude_id=plant.id
                )
            ):
                raise PlantConflict("A Plant with this name already exists in this Grow")

            changed = self._apply_update(plant, request)
            now_archived = plant.status == PlantStatus.ARCHIVED.value
            if not was_archived and now_archived:
                action = "plant.archived"
            elif was_archived and not now_archived:
                action = "plant.restored"
            else:
                action = "plant.updated"
            session.add(
                audit_record(
                    action,
                    "plant",
                    plant.id,
                    correlation_id,
                    details={"changed_fields": sorted(changed)},
                )
            )
            await session.flush()
            refreshed = await repository.get_plant(plant.id)
            assert refreshed is not None
            return await self._response(repository, refreshed)

    async def archive(self, plant_id: str, correlation_id: str) -> None:
        async with self._database.transaction() as session:
            repository = PlantRepository(session)
            plant = await repository.get_plant(plant_id)
            if plant is None:
                raise PlantNotFound("Plant was not found")
            if plant.status != PlantStatus.ARCHIVED.value:
                plant.status = PlantStatus.ARCHIVED.value
                plant.updated_at = datetime.now(UTC)
                session.add(
                    audit_record(
                        "plant.archived",
                        "plant",
                        plant.id,
                        correlation_id,
                        details={"name": plant.name},
                    )
                )
                await session.flush()

    async def transition_stage(
        self,
        plant_id: str,
        request: PlantStageTransitionCreate,
        correlation_id: str,
    ) -> PlantStageTransitionResult:
        async with self._database.transaction() as session:
            repository = PlantRepository(session)
            plant = await repository.get_plant(plant_id)
            if plant is None:
                raise PlantNotFound("Plant was not found")
            target = await repository.get_stage(request.to_stage_id)
            if target is None:
                raise PlantNotFound("Lifecycle stage was not found")
            if not target.enabled:
                raise PlantValidationError("The destination lifecycle stage is disabled")

            order = await repository.enabled_stage_order()
            order_ids = [stage.id for stage in order]
            requires = self._requires_confirmation(
                order_ids, plant.current_stage_id, request.to_stage_id
            )
            if requires and not request.confirmed:
                raise PlantTransitionConfirmationRequired(
                    "This stage change is backward or skipped and requires confirmation"
                )
            if request.source is not None:
                source = request.source.value
            elif requires:
                source = TransitionSource.USER_ADJUSTED.value
            else:
                source = TransitionSource.USER_CONFIRMED.value

            transition = repository.build_transition(
                plant.id,
                plant.current_stage_id,
                request.to_stage_id,
                request.effective_at,
                source,
                request.notes,
            )
            await repository.add_transition(transition)
            transitions = await repository.list_transitions(plant.id)
            new_stage_id = ordered_current_stage(
                self._to_order(item) for item in transitions
            )
            if new_stage_id != plant.current_stage_id:
                plant.current_stage_id = new_stage_id
                await session.flush()
                await session.refresh(plant, ["current_stage"])
            plant.updated_at = datetime.now(UTC)
            session.add(
                audit_record(
                    "plant.stage_transitioned",
                    "plant",
                    plant.id,
                    correlation_id,
                    details={
                        "to_stage_id": request.to_stage_id,
                        "source": source,
                    },
                )
            )
            await session.flush()
            refreshed = await repository.get_plant(plant.id)
            assert refreshed is not None
            response = await self._response(repository, refreshed)
            return PlantStageTransitionResult(
                transition=self._transition(transition),
                plant=response,
            )

    @staticmethod
    def _initial_effective_at(start_date: object) -> datetime:
        if isinstance(start_date, datetime):
            return start_date
        if start_date is not None:
            return datetime.combine(start_date, time.min, tzinfo=UTC)  # type: ignore[arg-type]
        return datetime.now(UTC)

    @staticmethod
    def _requires_confirmation(
        order_ids: list[str], current_id: str, target_id: str
    ) -> bool:
        if current_id not in order_ids or target_id not in order_ids:
            return True
        return requires_transition_confirmation(order_ids, current_id, target_id)

    @staticmethod
    def _to_order(transition: PlantStageTransition) -> TransitionOrder:
        return TransitionOrder(
            id=transition.id,
            to_stage_id=transition.to_stage_id,
            effective_at=PlantService._aware(transition.effective_at),
            created_at=PlantService._aware(transition.created_at),
        )

    @staticmethod
    def _aware(value: datetime) -> datetime:
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)

    @staticmethod
    def _validate_state(
        status: str, start_date: object, harvest_date: object
    ) -> None:
        plant_status = PlantStatus(status)
        if plant_status in _STATUS_REQUIRES_START and start_date is None:
            raise PlantValidationError("Start date is required once a Plant is active")
        if harvest_date is not None and plant_status not in _HARVEST_STATUSES:
            raise PlantValidationError(
                "Actual harvest date is only valid for harvested or completed Plants"
            )

    @staticmethod
    def _apply_update(plant: Plant, request: PlantUpdate) -> set[str]:
        changed: set[str] = set()
        fields = request.model_fields_set
        if request.name is not None:
            plant.name = request.name
            changed.add("name")
        if "seed_type" in fields:
            plant.seed_type = request.seed_type.value if request.seed_type is not None else None
            changed.add("seed_type")
        if "start_date" in fields:
            plant.start_date = request.start_date
            changed.add("start_date")
        if request.status is not None:
            plant.status = request.status.value
            changed.add("status")
        for field_name in (
            "container",
            "medium",
            "location",
            "expected_harvest_start",
            "expected_harvest_end",
            "actual_harvest_date",
            "notes",
        ):
            if field_name in fields:
                setattr(plant, field_name, getattr(request, field_name))
                changed.add(field_name)
        if changed:
            plant.updated_at = datetime.now(UTC)
        return changed

    @staticmethod
    def _compact_cultivar(cultivar: Cultivar) -> CompactCultivar:
        return CompactCultivar(
            id=cultivar.id,
            name=cultivar.name,
            breeder_name=cultivar.breeder.name if cultivar.breeder is not None else None,
        )

    @staticmethod
    def _transition(transition: PlantStageTransition) -> TransitionResponse:
        return TransitionResponse(
            id=transition.id,
            from_stage_id=transition.from_stage_id,
            to_stage_id=transition.to_stage_id,
            effective_at=PlantService._aware(transition.effective_at),
            source=TransitionSource(transition.source),
            notes=transition.notes,
            created_at=PlantService._aware(transition.created_at),
        )

    def _summary(self, plant: Plant) -> PlantSummary:
        return PlantSummary(
            id=plant.id,
            grow_id=plant.grow_id,
            name=plant.name,
            status=PlantStatus(plant.status),
            current_stage=CompactStage.model_validate(plant.current_stage),
            cultivar=self._compact_cultivar(plant.cultivar),
            start_date=plant.start_date,
        )

    async def _response(
        self, repository: PlantRepository, plant: Plant
    ) -> PlantResponse:
        grow: Grow = plant.grow
        space: GrowSpace | None = await repository.get_grow_space(grow.grow_space_id)
        stage: LifecycleStage = plant.current_stage
        transitions = await repository.list_transitions(plant.id)
        return PlantResponse(
            id=plant.id,
            grow=CompactRef(id=grow.id, name=grow.name),
            grow_space=CompactRef(
                id=grow.grow_space_id,
                name=space.name if space is not None else "Unknown Grow Space",
            ),
            cultivar=self._compact_cultivar(plant.cultivar),
            name=plant.name,
            propagation_source=PropagationSource(plant.propagation_source),
            seed_type=SeedType(plant.seed_type) if plant.seed_type is not None else None,
            start_date=plant.start_date,
            current_stage=CompactStage.model_validate(stage),
            status=PlantStatus(plant.status),
            container=plant.container,
            medium=plant.medium,
            location=plant.location,
            expected_harvest_start=plant.expected_harvest_start,
            expected_harvest_end=plant.expected_harvest_end,
            actual_harvest_date=plant.actual_harvest_date,
            notes=plant.notes,
            stage_transitions=[self._transition(item) for item in transitions],
            created_at=plant.created_at,
            updated_at=plant.updated_at,
        )
