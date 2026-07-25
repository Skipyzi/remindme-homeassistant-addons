# pyright: reportMissingImports=false
"""SQLAlchemy persistence queries for Plants and stage transitions."""

from collections.abc import Sequence
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import orm
from sqlalchemy.ext import asyncio as sa_async

from cultivation_assistant.db.models import (
    Cultivar,
    Grow,
    GrowSpace,
    LifecycleStage,
    Plant,
    PlantStageTransition,
)


class PlantRepository:
    """Persist Plant records without HTTP or transaction policy."""

    def __init__(self, session: sa_async.AsyncSession) -> None:
        self._session = session

    async def get_grow(self, grow_id: str) -> Grow | None:
        return await self._session.get(Grow, grow_id)

    async def get_grow_space(self, grow_space_id: str) -> GrowSpace | None:
        return await self._session.get(GrowSpace, grow_space_id)

    async def get_cultivar(self, cultivar_id: str) -> Cultivar | None:
        return await self._session.get(Cultivar, cultivar_id)

    async def get_stage(self, stage_id: str) -> LifecycleStage | None:
        return await self._session.get(LifecycleStage, stage_id)

    async def enabled_stage_order(self) -> list[LifecycleStage]:
        statement = (
            sa.select(LifecycleStage)
            .where(LifecycleStage.enabled.is_(True))
            .order_by(LifecycleStage.position)
        )
        result = await self._session.scalars(statement)
        return list(result.all())

    async def active_name_exists(
        self, grow_id: str, name: str, *, exclude_id: str | None = None
    ) -> bool:
        statement = sa.select(sa.literal(True)).where(
            Plant.grow_id == grow_id,
            Plant.status != "archived",
            sa.func.lower(Plant.name) == name.casefold(),
        )
        if exclude_id is not None:
            statement = statement.where(Plant.id != exclude_id)
        return bool(await self._session.scalar(statement.limit(1)))

    async def add_plant(self, plant: Plant) -> Plant:
        self._session.add(plant)
        await self._session.flush()
        return plant

    async def add_transition(self, transition: PlantStageTransition) -> PlantStageTransition:
        self._session.add(transition)
        await self._session.flush()
        return transition

    async def get_plant(self, plant_id: str) -> Plant | None:
        statement = (
            sa.select(Plant)
            .where(Plant.id == plant_id)
            .options(
                orm.joinedload(Plant.grow),
                orm.joinedload(Plant.cultivar).joinedload(Cultivar.breeder),
                orm.joinedload(Plant.current_stage),
                orm.selectinload(Plant.transitions),
            )
        )
        plant: Plant | None = await self._session.scalar(statement)
        return plant

    async def list_transitions(self, plant_id: str) -> list[PlantStageTransition]:
        statement = (
            sa.select(PlantStageTransition)
            .where(PlantStageTransition.plant_id == plant_id)
            .order_by(
                PlantStageTransition.effective_at,
                PlantStageTransition.created_at,
                PlantStageTransition.id,
            )
        )
        result = await self._session.scalars(statement)
        return list(result.all())

    async def list_plants(
        self,
        *,
        grow_id: str | None = None,
        grow_space_id: str | None = None,
        statuses: Sequence[str] | None = None,
        stage_id: str | None = None,
        query: str | None = None,
        include_archived: bool = False,
    ) -> list[Plant]:
        statement = (
            sa.select(Plant)
            .options(
                orm.joinedload(Plant.current_stage),
                orm.joinedload(Plant.cultivar).joinedload(Cultivar.breeder),
            )
            .order_by(sa.func.lower(Plant.name))
        )
        if grow_id is not None:
            statement = statement.where(Plant.grow_id == grow_id)
        if grow_space_id is not None:
            statement = statement.join(Grow, Plant.grow_id == Grow.id).where(
                Grow.grow_space_id == grow_space_id
            )
        if statuses:
            statement = statement.where(Plant.status.in_(list(statuses)))
        elif not include_archived:
            statement = statement.where(Plant.status != "archived")
        if stage_id is not None:
            statement = statement.where(Plant.current_stage_id == stage_id)
        if query:
            statement = statement.where(
                sa.func.lower(Plant.name).like(f"%{query.casefold()}%")
            )
        result = await self._session.scalars(statement)
        return list(result.unique().all())

    @staticmethod
    def build_plant(create: dict[str, object]) -> Plant:
        return Plant(**create)

    @staticmethod
    def build_transition(
        plant_id: str,
        from_stage_id: str | None,
        to_stage_id: str,
        effective_at: datetime,
        source: str,
        notes: str | None,
    ) -> PlantStageTransition:
        return PlantStageTransition(
            plant_id=plant_id,
            from_stage_id=from_stage_id,
            to_stage_id=to_stage_id,
            effective_at=effective_at,
            source=source,
            notes=notes,
        )
