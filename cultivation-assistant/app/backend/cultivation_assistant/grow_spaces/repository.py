# pyright: reportMissingImports=false
"""SQLAlchemy persistence queries for grow spaces and entity mappings."""

from decimal import Decimal

import sqlalchemy as sa
from sqlalchemy import orm
from sqlalchemy.ext import asyncio as sa_async

from cultivation_assistant.db.models import EntityMapping, GrowSpace
from cultivation_assistant.grow_spaces.dimensions import CanonicalDimensions
from cultivation_assistant.grow_spaces.schemas import (
    EntityMappingCreate,
    GrowSpaceCreate,
)


class GrowSpaceRepository:
    """Persist grow-space records without HTTP or transaction policy."""

    def __init__(self, session: sa_async.AsyncSession) -> None:
        self._session = session

    async def list(self, *, include_archived: bool = False) -> list[GrowSpace]:
        """List grow spaces with mappings eagerly loaded."""
        statement = (
            sa.select(GrowSpace)
            .options(orm.selectinload(GrowSpace.mappings))
            .order_by(GrowSpace.active.desc(), sa.func.lower(GrowSpace.name))
        )
        if not include_archived:
            statement = statement.where(GrowSpace.active.is_(True))
        result = await self._session.scalars(statement)
        return list(result.unique().all())

    async def get(self, grow_space_id: str) -> GrowSpace | None:
        """Load one grow space and its mappings."""
        statement = (
            sa.select(GrowSpace)
            .where(GrowSpace.id == grow_space_id)
            .options(orm.selectinload(GrowSpace.mappings))
        )
        grow_space: GrowSpace | None = await self._session.scalar(statement)
        return grow_space

    async def active_name_exists(
        self,
        name: str,
        *,
        exclude_id: str | None = None,
    ) -> bool:
        """Check case-insensitive active-name uniqueness."""
        statement = sa.select(sa.literal(True)).where(
            GrowSpace.active.is_(True),
            sa.func.lower(GrowSpace.name) == name.casefold(),
        )
        if exclude_id is not None:
            statement = statement.where(GrowSpace.id != exclude_id)
        return bool(await self._session.scalar(statement.limit(1)))

    async def add(
        self,
        request: GrowSpaceCreate,
        dimensions: CanonicalDimensions,
        area_m2: Decimal,
        volume_m3: Decimal | None,
    ) -> GrowSpace:
        """Create and flush one grow space without committing."""
        grow_space = GrowSpace(
            name=request.name,
            description=request.description,
            location=request.location,
            space_type=request.space_type.value,
            length_m=dimensions.length_m,
            width_m=dimensions.width_m,
            height_m=dimensions.height_m,
            dimension_unit=request.dimensions.unit.value,
            area_m2=area_m2,
            volume_m3=volume_m3,
        )
        self._session.add(grow_space)
        await self._session.flush()
        return grow_space

    async def mapping_exists(
        self,
        grow_space_id: str,
        entity_id: str,
        role: str,
    ) -> bool:
        """Check the unique entity-role identity within one grow space."""
        statement = sa.select(sa.literal(True)).where(
            EntityMapping.grow_space_id == grow_space_id,
            EntityMapping.entity_id == entity_id,
            EntityMapping.role == role,
        )
        return bool(await self._session.scalar(statement.limit(1)))

    async def add_mapping(
        self,
        grow_space: GrowSpace,
        request: EntityMappingCreate,
        *,
        source_unit: str | None,
        normalized_unit: str | None,
    ) -> EntityMapping:
        """Create and flush one mapping without committing."""
        stale_after_seconds = request.stale_after_seconds
        if stale_after_seconds is None:
            raise ValueError("Mapping stale threshold was not initialized")
        mapping = EntityMapping(
            grow_space_id=grow_space.id,
            entity_id=request.entity_id,
            role=request.role,
            display_name=request.display_name,
            priority=request.priority,
            source_unit=source_unit,
            normalized_unit=normalized_unit,
            enabled=request.enabled,
            calibration=request.calibration,
            stale_after_seconds=stale_after_seconds,
        )
        self._session.add(mapping)
        await self._session.flush()
        return mapping

    async def get_mapping(
        self,
        grow_space_id: str,
        mapping_id: str,
    ) -> EntityMapping | None:
        """Load one mapping constrained to its grow-space parent."""
        statement = sa.select(EntityMapping).where(
            EntityMapping.id == mapping_id,
            EntityMapping.grow_space_id == grow_space_id,
        )
        mapping: EntityMapping | None = await self._session.scalar(statement)
        return mapping

    async def delete_mapping(self, mapping: EntityMapping) -> None:
        """Delete one mapping inside the caller-owned transaction."""
        await self._session.delete(mapping)
        await self._session.flush()
