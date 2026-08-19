"""Periodic sampler persisting reservoir level readings for forecasts."""

import asyncio
from datetime import UTC, datetime, timedelta

import structlog

from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import ReservoirReading
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.reservoirs.repository import ReservoirRepository
from cultivation_assistant.reservoirs.volume import compute_volume

READINGS_RETENTION = timedelta(days=30)

logger = structlog.get_logger(__name__)


class ReservoirReadingRecorder:
    """Sample mapped reservoir level sensors into the readings table.

    A reading is recorded only when the source entity's Home Assistant
    ``last_updated`` advances, so an unchanged sensor produces no duplicate
    rows and consumption deltas stay meaningful.
    """

    def __init__(
        self,
        database: Database,
        state_cache: EntityStateCache,
        *,
        interval_seconds: int = 60,
    ) -> None:
        self._database = database
        self._state_cache = state_cache
        self._interval_seconds = interval_seconds
        self._last_sampled: dict[str, datetime] = {}

    async def run_forever(self, stop_event: asyncio.Event) -> None:
        """Sample on a fixed interval until stopped."""
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(
                    stop_event.wait(), timeout=self._interval_seconds
                )
                break
            except TimeoutError:
                pass
            try:
                await self.sample_once()
            except Exception:
                logger.exception("reservoir_reading_sample_failed")

    async def sample_once(self) -> int:
        """Record one reading per active reservoir with a usable level source.

        Returns the number of readings written. Sensors that are missing,
        unavailable, or unchanged since their last sample are skipped.
        """
        written = 0
        now = datetime.now(UTC)
        async with self._database.transaction() as session:
            repository = ReservoirRepository(session)
            reservoirs = await repository.list_reservoirs()
            for record in reservoirs:
                current = compute_volume(
                    record,
                    list(record.entity_mappings),
                    list(record.calibration_points),
                    self._state_cache,
                )
                if current is None:
                    continue
                last_sampled = self._last_sampled.get(current.source_entity_id)
                if last_sampled is not None and current.last_updated <= last_sampled:
                    continue
                session.add(
                    ReservoirReading(
                        reservoir_id=record.id,
                        recorded_at=now,
                        source_entity_id=current.source_entity_id,
                        role=current.role,
                        volume_liters=current.volume_liters,
                        level_percent=current.level_percent,
                    )
                )
                self._last_sampled[current.source_entity_id] = current.last_updated
                written += 1
            await repository.prune_readings(now - READINGS_RETENTION)
        if written:
            logger.info("reservoir_readings_recorded", count=written)
        return written
