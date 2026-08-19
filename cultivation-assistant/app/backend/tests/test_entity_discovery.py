# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from cultivation_assistant.config import Settings
from cultivation_assistant.db.engine import Database
from cultivation_assistant.grow_spaces.discovery import EntityDiscoveryService
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.main import create_app
from cultivation_assistant.runtime import RuntimeStatus
from httpx import ASGITransport, AsyncClient


def state(
    entity_id: str,
    value: str,
    unit: str | None,
    device_class: str | None,
    friendly_name: str,
) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": value,
        "last_updated": "2026-07-22T12:00:00Z",
        "attributes": {
            "unit_of_measurement": unit,
            "device_class": device_class,
            "friendly_name": friendly_name,
        },
    }


def test_discovery_ranks_exact_then_convertible_then_hint() -> None:
    cache = EntityStateCache()
    cache.update(state("sensor.room_temp", "24", "°C", "temperature", "Room temperature"))
    cache.update(state("sensor.tent_temp_f", "77", "°F", "temperature", "Tent temperature"))
    cache.update(state("sensor.air_probe", "24", None, None, "Air probe"))

    candidates = EntityDiscoveryService(cache).suggest("air_temperature")

    assert [item.entity_id for item in candidates] == [
        "sensor.room_temp",
        "sensor.tent_temp_f",
        "sensor.air_probe",
    ]
    assert [item.compatibility for item in candidates] == [
        "compatible",
        "convertible",
        "unknown",
    ]


def test_discovery_excludes_known_incompatible_units_and_domains() -> None:
    cache = EntityStateCache()
    cache.update(state("sensor.co2", "800", "ppm", "carbon_dioxide", "Tent CO2"))
    cache.update(state("sensor.bad_humidity", "800", "ppm", "humidity", "Humidity"))
    cache.update(state("switch.temperature", "on", None, None, "Temperature switch"))

    candidates = EntityDiscoveryService(cache).suggest("relative_humidity")

    assert candidates == []


def test_unavailable_compatible_entity_is_retained() -> None:
    cache = EntityStateCache()
    cache.update(
        state(
            "sensor.room_temp",
            "unavailable",
            "°C",
            "temperature",
            "Room temperature",
        )
    )

    candidate = EntityDiscoveryService(cache).suggest("air_temperature")[0]

    assert not candidate.available


@pytest.fixture
async def discovery_client(
    tmp_path: Path,
) -> AsyncGenerator[tuple[AsyncClient, RuntimeStatus]]:
    database_path = tmp_path / "discovery.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")
    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    status = RuntimeStatus(home_assistant_connected=True)
    app = create_app(
        runtime_status=status,
        settings=Settings(data_dir=tmp_path, frontend_dist=tmp_path / "missing"),
        database=database,
    )
    app.state.entity_state_cache.update(
        state("sensor.room_temp", "24", "°C", "temperature", "Room temperature")
    )
    async with app.router.lifespan_context(app):
        status.home_assistant_connected = True
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client, status


async def test_discovery_endpoint_returns_ranked_candidates(
    discovery_client: tuple[AsyncClient, RuntimeStatus],
) -> None:
    client, _ = discovery_client
    response = await client.get("/api/v1/home-assistant/entities?role=air_temperature")

    assert response.status_code == 200
    assert response.json()["items"][0]["entity_id"] == "sensor.room_temp"


async def test_discovery_endpoint_reports_home_assistant_offline(
    discovery_client: tuple[AsyncClient, RuntimeStatus],
) -> None:
    client, status = discovery_client
    status.home_assistant_connected = False

    response = await client.get("/api/v1/home-assistant/entities?role=air_temperature")

    assert response.status_code == 503
