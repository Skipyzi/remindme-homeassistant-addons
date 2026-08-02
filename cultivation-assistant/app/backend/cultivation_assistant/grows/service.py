"""Transactional application service for Grows."""

from datetime import UTC, date, datetime

from cultivation_assistant.audit import audit_record
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import Grow, GrowSpace, Plant
from cultivation_assistant.grows.repository import GrowRepository
from cultivation_assistant.grows.schemas import (
    CompactPlant,
    CompactStage,
    GrowCreate,
    GrowListResponse,
    GrowResponse,
    GrowSummary,
    GrowUpdate,
)
from cultivation_assistant.lifecycle.rules import GrowStatus


class GrowNotFound(RuntimeError):
    """Raised when a Grow or its Grow Space does not exist."""


class GrowConflict(RuntimeError):
    """Raised when a Grow name conflicts within a Grow Space."""


class GrowValidationError(RuntimeError):
    """Raised when domain validation rejects a Grow change."""


class GrowService:
    """Apply Grow policy inside explicit database transactions."""

    def __init__(self, database: Database) -> None:
        self._database = database

    async def list_grows(
        self,
        *,
        grow_space_id: str | None = None,
        statuses: list[str] | None = None,
        include_archived: bool = False,
    ) -> GrowListResponse:
        async with self._database.transaction() as session:
            repository = GrowRepository(session)
            grows = await repository.list_grows(
                grow_space_id=grow_space_id,
                statuses=statuses,
                include_archived=include_archived,
            )
            counts = await repository.status_counts([grow.id for grow in grows])
            spaces: dict[str, GrowSpace | None] = {}
            for grow in grows:
                if grow.grow_space_id not in spaces:
                    spaces[grow.grow_space_id] = await repository.get_grow_space(
                        grow.grow_space_id
                    )
            return GrowListResponse(
                items=[
                    self._summary(grow, spaces[grow.grow_space_id], counts.get(grow.id, {}))
                    for grow in grows
                ]
            )

    async def get(self, grow_id: str) -> GrowResponse:
        async with self._database.transaction() as session:
            repository = GrowRepository(session)
            grow = await repository.get(grow_id)
            if grow is None:
                raise GrowNotFound("Grow was not found")
            space = await repository.get_grow_space(grow.grow_space_id)
            plants = await repository.compact_plants(grow.id)
            counts = self._counts_from_plants(plants)
            return GrowResponse(
                **self._summary(grow, space, counts).model_dump(),
                plants=[self._compact_plant(plant) for plant in plants],
            )

    async def create(self, request: GrowCreate, correlation_id: str) -> GrowResponse:
        async with self._database.transaction() as session:
            repository = GrowRepository(session)
            space = await repository.get_grow_space(request.grow_space_id)
            if space is None:
                raise GrowNotFound("Grow Space was not found")
            if request.status is not GrowStatus.ARCHIVED and (
                await repository.active_name_exists(request.grow_space_id, request.name)
            ):
                raise GrowConflict("A Grow with this name already exists in this Grow Space")
            grow = await repository.add(
                request.grow_space_id,
                request.name,
                request.status.value,
                request.start_date,
                request.end_date,
                request.notes,
            )
            session.add(
                audit_record(
                    "grow.created",
                    "grow",
                    grow.id,
                    correlation_id,
                    details={"name": grow.name, "grow_space_id": grow.grow_space_id},
                )
            )
            await session.flush()
            return GrowResponse(
                **self._summary(grow, space, {}).model_dump(),
                plants=[],
            )

    async def update(
        self, grow_id: str, request: GrowUpdate, correlation_id: str
    ) -> GrowResponse:
        async with self._database.transaction() as session:
            repository = GrowRepository(session)
            grow = await repository.get(grow_id)
            if grow is None:
                raise GrowNotFound("Grow was not found")
            was_archived = grow.status == GrowStatus.ARCHIVED.value

            resulting_name = request.name if request.name is not None else grow.name
            resulting_status = (
                request.status.value if request.status is not None else grow.status
            )
            resulting_start = (
                request.start_date
                if "start_date" in request.model_fields_set
                else grow.start_date
            )
            resulting_end = (
                request.end_date if "end_date" in request.model_fields_set else grow.end_date
            )
            self._validate_dates(resulting_status, resulting_start, resulting_end)
            if resulting_status != GrowStatus.ARCHIVED.value and (
                await repository.active_name_exists(
                    grow.grow_space_id, resulting_name, exclude_id=grow.id
                )
            ):
                raise GrowConflict("A Grow with this name already exists in this Grow Space")

            changed = self._apply_update(grow, request)
            now_archived = grow.status == GrowStatus.ARCHIVED.value
            if not was_archived and now_archived:
                action = "grow.archived"
            elif was_archived and not now_archived:
                action = "grow.restored"
            else:
                action = "grow.updated"
            session.add(
                audit_record(
                    action,
                    "grow",
                    grow.id,
                    correlation_id,
                    details={"changed_fields": sorted(changed)},
                )
            )
            await session.flush()
            space = await repository.get_grow_space(grow.grow_space_id)
            plants = await repository.compact_plants(grow.id)
            return GrowResponse(
                **self._summary(grow, space, self._counts_from_plants(plants)).model_dump(),
                plants=[self._compact_plant(plant) for plant in plants],
            )

    async def archive(self, grow_id: str, correlation_id: str) -> None:
        async with self._database.transaction() as session:
            repository = GrowRepository(session)
            grow = await repository.get(grow_id)
            if grow is None:
                raise GrowNotFound("Grow was not found")
            if grow.status != GrowStatus.ARCHIVED.value:
                grow.status = GrowStatus.ARCHIVED.value
                grow.updated_at = datetime.now(UTC)
                session.add(
                    audit_record(
                        "grow.archived",
                        "grow",
                        grow.id,
                        correlation_id,
                        details={"name": grow.name},
                    )
                )
                await session.flush()

    @staticmethod
    def _validate_dates(
        status: str, start_date: date | None, end_date: date | None
    ) -> None:
        if status in {GrowStatus.ACTIVE.value, GrowStatus.COMPLETED.value} and start_date is None:
            raise GrowValidationError("Start date is required for active or completed Grows")
        if start_date and end_date and end_date < start_date:
            raise GrowValidationError("End date cannot precede start date")

    @staticmethod
    def _apply_update(grow: Grow, request: GrowUpdate) -> set[str]:
        changed: set[str] = set()
        fields = request.model_fields_set
        if request.name is not None:
            grow.name = request.name
            changed.add("name")
        if request.status is not None:
            grow.status = request.status.value
            changed.add("status")
        if "start_date" in fields:
            grow.start_date = request.start_date
            changed.add("start_date")
        if "end_date" in fields:
            grow.end_date = request.end_date
            changed.add("end_date")
        if "notes" in fields:
            grow.notes = request.notes
            changed.add("notes")
        if changed:
            grow.updated_at = datetime.now(UTC)
        return changed

    @staticmethod
    def _counts_from_plants(plants: list[Plant]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for plant in plants:
            counts[plant.status] = counts.get(plant.status, 0) + 1
        return counts

    @staticmethod
    def _compact_plant(plant: Plant) -> CompactPlant:
        return CompactPlant(
            id=plant.id,
            name=plant.name,
            status=plant.status,
            current_stage=CompactStage.model_validate(plant.current_stage),
            start_date=plant.start_date,
        )

    @staticmethod
    def _summary(
        grow: Grow, space: GrowSpace | None, counts: dict[str, int]
    ) -> GrowSummary:
        return GrowSummary(
            id=grow.id,
            grow_space_id=grow.grow_space_id,
            grow_space_name=space.name if space is not None else "Unknown Grow Space",
            grow_space_active=bool(space.active) if space is not None else False,
            name=grow.name,
            status=GrowStatus(grow.status),
            start_date=grow.start_date,
            end_date=grow.end_date,
            notes=grow.notes,
            plant_count=sum(counts.values()),
            plant_status_counts=counts,
            created_at=grow.created_at,
            updated_at=grow.updated_at,
        )
