# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from cultivation_assistant.config import Settings
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import AuditLog
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.main import create_app
from cultivation_assistant.runtime import RuntimeStatus
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select


def cached_state(
    entity_id: str,
    value: str,
    unit: str | None,
    device_class: str | None,
) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": value,
        "last_updated": datetime.now(UTC).isoformat(),
        "attributes": {
            "unit_of_measurement": unit,
            "device_class": device_class,
            "friendly_name": entity_id,
        },
    }


@pytest.fixture
async def mapping_api(
    tmp_path: Path,
) -> AsyncGenerator[tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus]]:
    database_path = tmp_path / "reservoir-mapping-api.db"
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
    cache: EntityStateCache = app.state.entity_state_cache
    async with app.router.lifespan_context(app):
        status.home_assistant_connected = True
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client, database, cache, status


async def create_reservoir(client: AsyncClient) -> str:
    response = await client.post(
        "/api/v1/reservoirs",
        json={
            "name": "Mixing tank",
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
    return str(response.json()["id"])


def mapping_url(reservoir_id: str) -> str:
    return f"/api/v1/reservoirs/{reservoir_id}/entity-mappings"


async def test_creates_a_mapping_with_role_defaults(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, _, _ = mapping_api
    reservoir_id = await create_reservoir(client)

    response = await client.post(
        mapping_url(reservoir_id),
        json={"entity_id": "sensor.tank_level", "role": "level_percentage"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["role"] == "level_percentage"
    assert body["normalized_unit"] == "%"
    assert body["stale_after_seconds"] == 300
    assert body["compatibility"] == "unknown"


async def test_duplicate_entity_role_is_conflict(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, _, _ = mapping_api
    reservoir_id = await create_reservoir(client)
    payload = {"entity_id": "sensor.tank_level", "role": "level_percentage"}

    assert (await client.post(mapping_url(reservoir_id), json=payload)).status_code == 201
    duplicate = await client.post(mapping_url(reservoir_id), json=payload)

    assert duplicate.status_code == 409


async def test_multiple_entities_can_map_to_same_role(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, _, _ = mapping_api
    reservoir_id = await create_reservoir(client)

    first = await client.post(
        mapping_url(reservoir_id),
        json={"entity_id": "sensor.tank_level_a", "role": "level_percentage", "priority": 10},
    )
    second = await client.post(
        mapping_url(reservoir_id),
        json={"entity_id": "sensor.tank_level_b", "role": "level_percentage", "priority": 20},
    )

    assert first.status_code == second.status_code == 201


async def test_known_incompatible_entity_is_rejected(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, cache, _ = mapping_api
    cache.update(cached_state("sensor.bad_humidity", "800", "ppm", "humidity"))
    reservoir_id = await create_reservoir(client)

    response = await client.post(
        mapping_url(reservoir_id),
        json={"entity_id": "sensor.bad_humidity", "role": "level_percentage"},
    )

    assert response.status_code == 422


async def test_mapping_patch_delete_and_audit(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, database, _, _ = mapping_api
    reservoir_id = await create_reservoir(client)
    created = await client.post(
        mapping_url(reservoir_id),
        json={"entity_id": "sensor.tank_level", "role": "level_percentage"},
    )
    mapping_id = created.json()["id"]

    updated = await client.patch(
        f"{mapping_url(reservoir_id)}/{mapping_id}",
        json={"enabled": False, "priority": 5},
    )
    deleted = await client.delete(f"{mapping_url(reservoir_id)}/{mapping_id}")

    async with database.transaction() as session:
        audit_count = await session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.resource_type == "reservoir_entity_mapping")
        )

    assert not updated.json()["enabled"]
    assert updated.json()["priority"] == 5
    assert deleted.status_code == 204
    assert audit_count == 3


async def test_detail_normalizes_live_percentage_reading(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, cache, _ = mapping_api
    cache.update(cached_state("sensor.tank_level", "68", "%", None))
    reservoir_id = await create_reservoir(client)
    await client.post(
        mapping_url(reservoir_id),
        json={"entity_id": "sensor.tank_level", "role": "level_percentage"},
    )

    response = await client.get(f"/api/v1/reservoirs/{reservoir_id}")
    reading = response.json()["live_readings"][0]

    assert Decimal(str(reading["normalized_value"])) == Decimal("68")
    assert reading["normalized_unit"] == "%"
    assert not reading["stale"]


async def test_binary_leak_role_normalizes_to_boolean(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, cache, _ = mapping_api
    cache.update(
        cached_state("binary_sensor.tray_leak", "on", None, "moisture")
    )
    reservoir_id = await create_reservoir(client)
    await client.post(
        mapping_url(reservoir_id),
        json={"entity_id": "binary_sensor.tray_leak", "role": "leak"},
    )

    response = await client.get(f"/api/v1/reservoirs/{reservoir_id}")
    reading = response.json()["live_readings"][0]

    assert reading["normalized_value"] is True
    # Binary roles default to the shorter staleness threshold.
    assert response.json()["mappings"][0]["stale_after_seconds"] == 60


async def test_discovery_endpoint_suggests_compatible_entities(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, cache, _ = mapping_api
    cache.update(cached_state("sensor.tank_percent", "70", "%", None))

    response = await client.get(
        "/api/v1/home-assistant/reservoir-entities?role=level_percentage"
    )

    assert response.status_code == 200
    assert response.json()["items"][0]["entity_id"] == "sensor.tank_percent"


async def test_discovery_rejects_unknown_role(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache, RuntimeStatus],
) -> None:
    client, _, _, _ = mapping_api

    response = await client.get(
        "/api/v1/home-assistant/reservoir-entities?role=not_a_role"
    )

    assert response.status_code == 422
