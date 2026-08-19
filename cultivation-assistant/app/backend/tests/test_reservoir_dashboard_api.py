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


def cached_state(
    entity_id: str,
    value: str,
    unit: str | None,
) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": value,
        "last_updated": datetime.now(UTC).isoformat(),
        "attributes": {
            "unit_of_measurement": unit,
            "device_class": None,
            "friendly_name": entity_id,
        },
    }


@pytest.fixture
async def dashboard_env(
    tmp_path: Path,
) -> AsyncGenerator[tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder]]:
    database_path = tmp_path / "dashboard.db"
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


async def create_reservoir(
    client: AsyncClient,
    *,
    name: str = "Mixing tank",
    refill_threshold: str | None = "20",
) -> str:
    response = await client.post(
        "/api/v1/reservoirs",
        json={
            "name": name,
            "reservoir_type": "mixing_tank",
            "capacity_liters": "100",
            "refill_threshold_liters": refill_threshold,
            "geometry": {
                "shape": "rectangular",
                "unit": "cm",
                "length": "50",
                "width": "40",
                "height": "60",
            },
        },
    )
    return str(response.json()["id"])


async def map_level_sensor(client: AsyncClient, reservoir_id: str) -> None:
    mapping = await client.post(
        f"/api/v1/reservoirs/{reservoir_id}/entity-mappings",
        json={"entity_id": "sensor.tank_level", "role": "level_percentage"},
    )
    assert mapping.status_code == 201, mapping.text


async def seed_history(
    database: Database,
    reservoir_id: str,
    samples: list[tuple[float, float]],
) -> None:
    """Insert (hours_ago, volume) reading pairs directly."""
    now = datetime.now(UTC)
    async with database.transaction() as session:
        for hours_ago, volume in samples:
            session.add(
                ReservoirReading(
                    reservoir_id=reservoir_id,
                    recorded_at=now - timedelta(hours=hours_ago),
                    source_entity_id="sensor.tank_level",
                    role="level_percentage",
                    volume_liters=Decimal(str(volume)),
                    level_percent=Decimal(str(volume)),
                )
            )


async def test_dashboard_reports_current_consumption_and_forecast(
    dashboard_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, database, cache, recorder = dashboard_env
    cache.update(cached_state("sensor.tank_level", "60", "%"))
    reservoir_id = await create_reservoir(client)
    await map_level_sensor(client, reservoir_id)
    await seed_history(
        database,
        reservoir_id,
        [
            (30, 100),  # older than 24h
            (20, 90),  # -10
            (10, 70),  # -20
            (0.5, 60),  # -10 (latest, matches live state)
        ],
    )
    await recorder.sample_once()

    response = await client.get(f"/api/v1/reservoirs/{reservoir_id}/dashboard")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["data_quality"] == "good"
    assert Decimal(body["current"]["volume_liters"]) == Decimal("60")
    assert Decimal(body["current"]["level_percent"]) == Decimal("60")
    assert Decimal(body["consumption"]["daily_liters"]) == Decimal("40")
    assert body["consumption"]["seven_day_average_liters"] is not None
    forecast = body["forecast"]
    assert Decimal(forecast["remaining_until_refill_liters"]) == Decimal("40")
    assert Decimal(forecast["hours_remaining"]) == Decimal("24.00")
    assert forecast["estimated_refill_at"] is not None


async def test_dashboard_flags_no_level_source(
    dashboard_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, _, _, _ = dashboard_env
    reservoir_id = await create_reservoir(client, name="Bare tank")

    response = await client.get(f"/api/v1/reservoirs/{reservoir_id}/dashboard")

    assert response.status_code == 200
    body = response.json()
    assert body["data_quality"] == "no_level_source"
    assert body["current"] is None
    assert body["forecast"] is None


async def test_dashboard_flags_sensor_unavailable(
    dashboard_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, _, cache, _ = dashboard_env
    cache.update(cached_state("sensor.tank_level", "unavailable", None))
    reservoir_id = await create_reservoir(client)
    await map_level_sensor(client, reservoir_id)

    response = await client.get(f"/api/v1/reservoirs/{reservoir_id}/dashboard")

    assert response.status_code == 200
    assert response.json()["data_quality"] == "sensor_unavailable"


async def test_dashboard_flags_insufficient_history(
    dashboard_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, database, cache, _ = dashboard_env
    cache.update(cached_state("sensor.tank_level", "60", "%"))
    reservoir_id = await create_reservoir(client)
    await map_level_sensor(client, reservoir_id)
    await seed_history(database, reservoir_id, [(2, 65), (1, 60)])

    response = await client.get(f"/api/v1/reservoirs/{reservoir_id}/dashboard")

    assert response.status_code == 200
    body = response.json()
    assert body["data_quality"] == "insufficient_history"
    assert Decimal(body["consumption"]["daily_liters"]) == Decimal("5")
    assert body["consumption"]["seven_day_average_liters"] is None
    # Forecasts are suppressed until at least a full day of history exists.
    assert body["forecast"] is None


async def test_dashboard_unknown_reservoir_is_not_found(
    dashboard_env: tuple[AsyncClient, Database, EntityStateCache, ReservoirReadingRecorder],
) -> None:
    client, _, _, _ = dashboard_env

    response = await client.get("/api/v1/reservoirs/missing/dashboard")

    assert response.status_code == 404
