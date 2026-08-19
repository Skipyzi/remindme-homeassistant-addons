# pyright: reportMissingImports=false
from collections.abc import AsyncGenerator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from cultivation_assistant.config import Settings
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import ReservoirReading
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.main import create_app
from cultivation_assistant.reservoirs.readings import ReservoirReadingRecorder
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select


def cached_state(
    entity_id: str,
    value: str,
    unit: str | None,
    last_updated: datetime | None = None,
) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": value,
        "last_updated": (last_updated or datetime.now(UTC)).isoformat(),
        "attributes": {
            "unit_of_measurement": unit,
            "device_class": None,
            "friendly_name": entity_id,
        },
    }


async def create_percentage_reservoir(client: AsyncClient, name: str = "Mixing tank") -> str:
    response = await client.post(
        "/api/v1/reservoirs",
        json={
            "name": name,
            "reservoir_type": "mixing_tank",
            "capacity_liters": "100",
            "geometry": {
                "shape": "rectangular",
                "unit": "cm",
                "length": "50",
                "width": "40",
                "height": "60",
            },
        },
    )
    reservoir_id = str(response.json()["id"])
    mapping = await client.post(
        f"/api/v1/reservoirs/{reservoir_id}/entity-mappings",
        json={"entity_id": "sensor.tank_level", "role": "level_percentage"},
    )
    assert mapping.status_code == 201, mapping.text
    return reservoir_id


RecorderEnv = tuple[
    AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder
]


@pytest.fixture
async def recorder_env(tmp_path: Path) -> AsyncGenerator[RecorderEnv]:
    database_path = tmp_path / "recorder.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")
    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    app = create_app(
        settings=Settings(data_dir=tmp_path, frontend_dist=tmp_path / "missing"),
        database=database,
    )
    cache: EntityStateCache = app.state.entity_state_cache
    recorder: ReservoirReadingRecorder = app.state.reservoir_reading_recorder
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as client:
            yield client, database, cache, recorder


async def test_sample_once_records_a_reading(
    recorder_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, database, cache, recorder = recorder_env
    # Seed the cache before mapping so the mapping captures a source unit.
    cache.update(cached_state("sensor.tank_level", "68", "%"))
    reservoir_id = await create_percentage_reservoir(client)

    written = await recorder.sample_once()

    assert written == 1
    async with database.transaction() as session:
        readings = list(
            await session.scalars(
                select(ReservoirReading).where(
                    ReservoirReading.reservoir_id == reservoir_id
                )
            )
        )
    assert len(readings) == 1
    assert readings[0].volume_liters == 68
    assert readings[0].level_percent == 68
    assert readings[0].source_entity_id == "sensor.tank_level"


async def test_sample_once_dedupes_unchanged_states(
    recorder_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, database, cache, recorder = recorder_env
    stamp = datetime.now(UTC)
    cache.update(cached_state("sensor.tank_level", "68", "%", last_updated=stamp))
    await create_percentage_reservoir(client)

    assert await recorder.sample_once() == 1
    # Same HA last_updated: no duplicate row.
    assert await recorder.sample_once() == 0

    newer = stamp + timedelta(minutes=5)
    cache.update(cached_state("sensor.tank_level", "60", "%", last_updated=newer))
    assert await recorder.sample_once() == 1

    async with database.transaction() as session:
        count = len(
            list(
                await session.scalars(
                    select(ReservoirReading).where(
                        ReservoirReading.source_entity_id == "sensor.tank_level"
                    )
                )
            )
        )
    assert count == 2


async def test_sample_once_skips_unavailable_sensors(
    recorder_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, _, cache, recorder = recorder_env
    cache.update(cached_state("sensor.tank_level", "unavailable", None))
    await create_percentage_reservoir(client)

    assert await recorder.sample_once() == 0


async def test_sample_once_skips_reservoirs_without_level_sources(
    recorder_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, _, _, recorder = recorder_env
    response = await client.post(
        "/api/v1/reservoirs",
        json={
            "name": "Bare tank",
            "reservoir_type": "mixing_tank",
            "capacity_liters": "100",
            "geometry": {
                "shape": "rectangular",
                "unit": "cm",
                "length": "50",
                "width": "40",
                "height": "60",
            },
        },
    )
    assert response.status_code == 201

    assert await recorder.sample_once() == 0


async def test_sample_once_prunes_readings_beyond_retention(
    recorder_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, database, cache, recorder = recorder_env
    cache.update(cached_state("sensor.tank_level", "68", "%"))
    reservoir_id = await create_percentage_reservoir(client)
    assert await recorder.sample_once() == 1

    async with database.transaction() as session:
        session.add(
            ReservoirReading(
                reservoir_id=reservoir_id,
                recorded_at=datetime.now(UTC) - timedelta(days=45),
                source_entity_id="sensor.old_probe",
                role="level_percentage",
                volume_liters=Decimal("50"),
            )
        )

    await recorder.sample_once()

    async with database.transaction() as session:
        old_count = len(
            list(
                await session.scalars(
                    select(ReservoirReading).where(
                        ReservoirReading.source_entity_id == "sensor.old_probe"
                    )
                )
            )
        )
    assert old_count == 0
