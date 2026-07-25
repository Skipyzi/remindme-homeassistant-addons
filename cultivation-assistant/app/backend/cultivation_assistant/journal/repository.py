# pyright: reportMissingImports=false
"""SQLAlchemy persistence queries for journal entries, measurements, and photos."""

import sqlalchemy as sa
from sqlalchemy import orm
from sqlalchemy.ext import asyncio as sa_async

from cultivation_assistant.db.models import (
    Grow,
    JournalEntry,
    LifecycleStage,
    Measurement,
    Photo,
    Plant,
    PlantStageTransition,
)


class JournalRepository:
    """Persist journal-slice records without HTTP or transaction policy."""

    def __init__(self, session: sa_async.AsyncSession) -> None:
        self._session = session

    async def get_plant(self, plant_id: str) -> Plant | None:
        return await self._session.get(Plant, plant_id)

    async def get_grow(self, grow_id: str) -> Grow | None:
        return await self._session.get(Grow, grow_id)

    async def get_stage(self, stage_id: str) -> LifecycleStage | None:
        return await self._session.get(LifecycleStage, stage_id)

    async def add_entry(self, entry: JournalEntry) -> JournalEntry:
        self._session.add(entry)
        await self._session.flush()
        await self._session.refresh(entry, ["related_stage"])
        return entry

    async def get_entry(self, entry_id: str) -> JournalEntry | None:
        statement = (
            sa.select(JournalEntry)
            .where(JournalEntry.id == entry_id)
            .options(orm.joinedload(JournalEntry.related_stage))
        )
        entry: JournalEntry | None = await self._session.scalar(statement)
        return entry

    async def list_entries(self, subject_type: str, subject_id: str) -> list[JournalEntry]:
        statement = (
            sa.select(JournalEntry)
            .where(
                JournalEntry.subject_type == subject_type,
                JournalEntry.subject_id == subject_id,
            )
            .options(orm.joinedload(JournalEntry.related_stage))
            .order_by(JournalEntry.occurred_at.desc(), JournalEntry.created_at.desc())
        )
        result = await self._session.scalars(statement)
        return list(result.all())

    async def delete_entry(self, entry: JournalEntry) -> None:
        await self._session.delete(entry)
        await self._session.flush()

    async def add_measurement(self, measurement: Measurement) -> Measurement:
        self._session.add(measurement)
        await self._session.flush()
        return measurement

    async def get_measurement(self, measurement_id: str) -> Measurement | None:
        statement = sa.select(Measurement).where(Measurement.id == measurement_id)
        measurement: Measurement | None = await self._session.scalar(statement)
        return measurement

    async def list_measurements(self, plant_id: str) -> list[Measurement]:
        statement = (
            sa.select(Measurement)
            .where(Measurement.plant_id == plant_id)
            .order_by(Measurement.occurred_at.desc(), Measurement.created_at.desc())
        )
        result = await self._session.scalars(statement)
        return list(result.all())

    async def delete_measurement(self, measurement: Measurement) -> None:
        await self._session.delete(measurement)
        await self._session.flush()

    async def add_photo(self, photo: Photo) -> Photo:
        self._session.add(photo)
        await self._session.flush()
        await self._session.refresh(photo, ["stage"])
        return photo

    async def get_photo(self, photo_id: str) -> Photo | None:
        statement = (
            sa.select(Photo).where(Photo.id == photo_id).options(orm.joinedload(Photo.stage))
        )
        photo: Photo | None = await self._session.scalar(statement)
        return photo

    async def list_photos(self, plant_id: str) -> list[Photo]:
        statement = (
            sa.select(Photo)
            .where(Photo.plant_id == plant_id)
            .options(orm.joinedload(Photo.stage))
            .order_by(Photo.occurred_at.desc(), Photo.created_at.desc())
        )
        result = await self._session.scalars(statement)
        return list(result.all())

    async def delete_photo(self, photo: Photo) -> None:
        await self._session.delete(photo)
        await self._session.flush()

    async def list_transitions(self, plant_id: str) -> list[PlantStageTransition]:
        statement = (
            sa.select(PlantStageTransition)
            .where(PlantStageTransition.plant_id == plant_id)
            .order_by(
                PlantStageTransition.effective_at.desc(),
                PlantStageTransition.created_at.desc(),
            )
        )
        result = await self._session.scalars(statement)
        return list(result.all())
