# pyright: reportMissingImports=false
"""SQLAlchemy persistence queries for lifecycle stages."""

import sqlalchemy as sa
from sqlalchemy.ext import asyncio as sa_async

from cultivation_assistant.db.models import LifecycleStage, Plant, PlantStageTransition


class LifecycleRepository:
    """Persist lifecycle stage records without HTTP or transaction policy."""

    def __init__(self, session: sa_async.AsyncSession) -> None:
        self._session = session

    async def list_stages(self, *, include_disabled: bool = False) -> list[LifecycleStage]:
        statement = sa.select(LifecycleStage).order_by(LifecycleStage.position)
        if not include_disabled:
            statement = statement.where(LifecycleStage.enabled.is_(True))
        result = await self._session.scalars(statement)
        return list(result.all())

    async def enabled_order(self) -> list[LifecycleStage]:
        return await self.list_stages(include_disabled=False)

    async def get_stage(self, stage_id: str) -> LifecycleStage | None:
        return await self._session.get(LifecycleStage, stage_id)

    async def key_exists(self, key: str) -> bool:
        statement = sa.select(sa.literal(True)).where(LifecycleStage.key == key)
        return bool(await self._session.scalar(statement.limit(1)))

    async def max_position(self) -> int:
        result = await self._session.scalar(sa.select(sa.func.max(LifecycleStage.position)))
        return -1 if result is None else int(result)

    async def add_stage(
        self, key: str, label: str, enabled: bool, position: int
    ) -> LifecycleStage:
        stage = LifecycleStage(
            key=key,
            label=label,
            enabled=enabled,
            built_in=False,
            position=position,
        )
        self._session.add(stage)
        await self._session.flush()
        return stage

    async def is_referenced(self, stage_id: str) -> bool:
        plant_statement = sa.select(sa.literal(True)).where(
            Plant.current_stage_id == stage_id
        )
        if bool(await self._session.scalar(plant_statement.limit(1))):
            return True
        transition_statement = sa.select(sa.literal(True)).where(
            sa.or_(
                PlantStageTransition.from_stage_id == stage_id,
                PlantStageTransition.to_stage_id == stage_id,
            )
        )
        return bool(await self._session.scalar(transition_statement.limit(1)))

    async def delete_stage(self, stage: LifecycleStage) -> None:
        await self._session.delete(stage)
        await self._session.flush()
