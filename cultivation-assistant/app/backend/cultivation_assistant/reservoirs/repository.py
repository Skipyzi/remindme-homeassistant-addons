# pyright: reportMissingImports=false
"""SQLAlchemy persistence queries for reservoirs."""

from decimal import Decimal

import sqlalchemy as sa
from sqlalchemy import orm
from sqlalchemy.ext import asyncio as sa_async

from cultivation_assistant.db.models import (
    GrowSpace,
    Reservoir,
    ReservoirCalibrationPoint,
    ReservoirEntityMapping,
)
from cultivation_assistant.reservoirs.schemas import ReservoirMappingCreate


class ReservoirRepository:
    """Persist reservoir records without HTTP or transaction policy."""

    def __init__(self, session: sa_async.AsyncSession) -> None:
        self._session = session

    async def list_reservoirs(self, *, include_archived: bool = False) -> list[Reservoir]:
        statement = (
            sa.select(Reservoir)
            .options(orm.selectinload(Reservoir.entity_mappings))
            .order_by(Reservoir.active.desc(), sa.func.lower(Reservoir.name))
        )
        if not include_archived:
            statement = statement.where(Reservoir.active.is_(True))
        result = await self._session.scalars(statement)
        return list(result.all())

    async def get(self, reservoir_id: str) -> Reservoir | None:
        statement = (
            sa.select(Reservoir)
            .where(Reservoir.id == reservoir_id)
            .options(orm.selectinload(Reservoir.entity_mappings))
        )
        reservoir: Reservoir | None = await self._session.scalar(statement)
        return reservoir

    async def get_grow_space(self, grow_space_id: str) -> GrowSpace | None:
        return await self._session.get(GrowSpace, grow_space_id)

    async def active_name_exists(self, name: str, *, exclude_id: str | None = None) -> bool:
        statement = sa.select(sa.literal(True)).where(
            Reservoir.active.is_(True),
            sa.func.lower(Reservoir.name) == name.casefold(),
        )
        if exclude_id is not None:
            statement = statement.where(Reservoir.id != exclude_id)
        return bool(await self._session.scalar(statement.limit(1)))

    async def add(self, reservoir: Reservoir) -> Reservoir:
        self._session.add(reservoir)
        await self._session.flush()
        return reservoir

    async def mapping_exists(
        self,
        reservoir_id: str,
        entity_id: str,
        role: str,
    ) -> bool:
        """Check the unique entity-role identity within one reservoir."""
        statement = sa.select(sa.literal(True)).where(
            ReservoirEntityMapping.reservoir_id == reservoir_id,
            ReservoirEntityMapping.entity_id == entity_id,
            ReservoirEntityMapping.role == role,
        )
        return bool(await self._session.scalar(statement.limit(1)))

    async def add_mapping(
        self,
        reservoir: Reservoir,
        request: ReservoirMappingCreate,
        *,
        source_unit: str | None,
        normalized_unit: str | None,
    ) -> ReservoirEntityMapping:
        """Create and flush one mapping without committing."""
        stale_after_seconds = request.stale_after_seconds
        if stale_after_seconds is None:
            raise ValueError("Mapping stale threshold was not initialized")
        mapping = ReservoirEntityMapping(
            reservoir_id=reservoir.id,
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
        reservoir_id: str,
        mapping_id: str,
    ) -> ReservoirEntityMapping | None:
        """Load one mapping constrained to its reservoir parent."""
        statement = sa.select(ReservoirEntityMapping).where(
            ReservoirEntityMapping.id == mapping_id,
            ReservoirEntityMapping.reservoir_id == reservoir_id,
        )
        mapping: ReservoirEntityMapping | None = await self._session.scalar(statement)
        return mapping

    async def delete_mapping(self, mapping: ReservoirEntityMapping) -> None:
        """Delete one mapping inside the caller-owned transaction."""
        await self._session.delete(mapping)
        await self._session.flush()

    async def list_calibration_points(
        self, reservoir_id: str
    ) -> list[ReservoirCalibrationPoint]:
        statement = (
            sa.select(ReservoirCalibrationPoint)
            .where(ReservoirCalibrationPoint.reservoir_id == reservoir_id)
            .order_by(ReservoirCalibrationPoint.raw_value)
        )
        result = await self._session.scalars(statement)
        return list(result.all())

    async def replace_calibration_points(
        self, reservoir_id: str, points: list[tuple[Decimal, Decimal]]
    ) -> list[ReservoirCalibrationPoint]:
        await self._session.execute(
            sa.delete(ReservoirCalibrationPoint).where(
                ReservoirCalibrationPoint.reservoir_id == reservoir_id
            )
        )
        records = [
            ReservoirCalibrationPoint(
                reservoir_id=reservoir_id, raw_value=raw_value, volume_liters=volume_liters
            )
            for raw_value, volume_liters in points
        ]
        self._session.add_all(records)
        await self._session.flush()
        return sorted(records, key=lambda record: record.raw_value)
