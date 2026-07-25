# pyright: reportMissingImports=false
"""SQLAlchemy persistence queries for breeders and cultivars."""

import sqlalchemy as sa
from sqlalchemy.ext import asyncio as sa_async

from cultivation_assistant.db.models import Breeder, Cultivar


class LibraryRepository:
    """Persist breeder and cultivar records without HTTP or transaction policy."""

    def __init__(self, session: sa_async.AsyncSession) -> None:
        self._session = session

    async def list_breeders(self, *, include_inactive: bool = False) -> list[Breeder]:
        statement = sa.select(Breeder).order_by(sa.func.lower(Breeder.name))
        if not include_inactive:
            statement = statement.where(Breeder.active.is_(True))
        result = await self._session.scalars(statement)
        return list(result.all())

    async def get_breeder(self, breeder_id: str) -> Breeder | None:
        return await self._session.get(Breeder, breeder_id)

    async def breeder_name_exists(self, name: str, *, exclude_id: str | None = None) -> bool:
        statement = sa.select(sa.literal(True)).where(
            Breeder.active.is_(True),
            sa.func.lower(Breeder.name) == name.casefold(),
        )
        if exclude_id is not None:
            statement = statement.where(Breeder.id != exclude_id)
        return bool(await self._session.scalar(statement.limit(1)))

    async def add_breeder(self, name: str) -> Breeder:
        breeder = Breeder(name=name)
        self._session.add(breeder)
        await self._session.flush()
        return breeder

    async def list_cultivars(
        self,
        *,
        include_inactive: bool = False,
        breeder_id: str | None = None,
        query: str | None = None,
    ) -> list[Cultivar]:
        statement = sa.select(Cultivar).order_by(sa.func.lower(Cultivar.name))
        if not include_inactive:
            statement = statement.where(Cultivar.active.is_(True))
        if breeder_id is not None:
            statement = statement.where(Cultivar.breeder_id == breeder_id)
        if query:
            statement = statement.where(
                sa.func.lower(Cultivar.name).like(f"%{query.casefold()}%")
            )
        result = await self._session.scalars(statement)
        return list(result.all())

    async def get_cultivar(self, cultivar_id: str) -> Cultivar | None:
        return await self._session.get(Cultivar, cultivar_id)

    async def get_active_cultivar(self, cultivar_id: str) -> Cultivar | None:
        cultivar = await self.get_cultivar(cultivar_id)
        if cultivar is None or not cultivar.active:
            return None
        return cultivar

    async def cultivar_identity_exists(
        self,
        breeder_id: str | None,
        name: str,
        seed_type: str,
        *,
        exclude_id: str | None = None,
    ) -> bool:
        statement = sa.select(sa.literal(True)).where(
            Cultivar.active.is_(True),
            sa.func.lower(Cultivar.name) == name.casefold(),
            Cultivar.seed_type == seed_type,
        )
        if breeder_id is None:
            statement = statement.where(Cultivar.breeder_id.is_(None))
        else:
            statement = statement.where(Cultivar.breeder_id == breeder_id)
        if exclude_id is not None:
            statement = statement.where(Cultivar.id != exclude_id)
        return bool(await self._session.scalar(statement.limit(1)))

    async def add_cultivar(
        self, name: str, breeder_id: str | None, seed_type: str
    ) -> Cultivar:
        cultivar = Cultivar(name=name, breeder_id=breeder_id, seed_type=seed_type)
        self._session.add(cultivar)
        await self._session.flush()
        return cultivar
