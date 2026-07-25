# pyright: reportMissingImports=false
"""SQLAlchemy persistence queries for Grows."""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy import orm
from sqlalchemy.ext import asyncio as sa_async

from cultivation_assistant.db.models import Grow, GrowSpace, Plant


class GrowRepository:
    """Persist Grow records without HTTP or transaction policy."""

    def __init__(self, session: sa_async.AsyncSession) -> None:
        self._session = session

    async def get_grow_space(self, grow_space_id: str) -> GrowSpace | None:
        return await self._session.get(GrowSpace, grow_space_id)

    async def list_grows(
        self,
        *,
        grow_space_id: str | None = None,
        statuses: Sequence[str] | None = None,
        include_archived: bool = False,
    ) -> list[Grow]:
        statement = sa.select(Grow).order_by(
            Grow.grow_space_id, sa.func.lower(Grow.name)
        )
        if grow_space_id is not None:
            statement = statement.where(Grow.grow_space_id == grow_space_id)
        if statuses:
            statement = statement.where(Grow.status.in_(list(statuses)))
        elif not include_archived:
            statement = statement.where(Grow.status != "archived")
        result = await self._session.scalars(statement)
        return list(result.all())

    async def get(self, grow_id: str) -> Grow | None:
        return await self._session.get(Grow, grow_id)

    async def active_name_exists(
        self, grow_space_id: str, name: str, *, exclude_id: str | None = None
    ) -> bool:
        statement = sa.select(sa.literal(True)).where(
            Grow.grow_space_id == grow_space_id,
            Grow.status != "archived",
            sa.func.lower(Grow.name) == name.casefold(),
        )
        if exclude_id is not None:
            statement = statement.where(Grow.id != exclude_id)
        return bool(await self._session.scalar(statement.limit(1)))

    async def add(
        self,
        grow_space_id: str,
        name: str,
        status: str,
        start_date: object,
        end_date: object,
        notes: str | None,
    ) -> Grow:
        grow = Grow(
            grow_space_id=grow_space_id,
            name=name,
            status=status,
            start_date=start_date,
            end_date=end_date,
            notes=notes,
        )
        self._session.add(grow)
        await self._session.flush()
        return grow

    async def status_counts(self, grow_ids: Sequence[str]) -> dict[str, dict[str, int]]:
        if not grow_ids:
            return {}
        statement = (
            sa.select(Plant.grow_id, Plant.status, sa.func.count())
            .where(Plant.grow_id.in_(list(grow_ids)))
            .group_by(Plant.grow_id, Plant.status)
        )
        counts: dict[str, dict[str, int]] = {}
        for grow_id, status, count in await self._session.execute(statement):
            counts.setdefault(grow_id, {})[status] = int(count)
        return counts

    async def compact_plants(self, grow_id: str) -> list[Plant]:
        statement = (
            sa.select(Plant)
            .where(Plant.grow_id == grow_id)
            .options(orm.joinedload(Plant.current_stage))
            .order_by(sa.func.lower(Plant.name))
        )
        result = await self._session.scalars(statement)
        return list(result.unique().all())
