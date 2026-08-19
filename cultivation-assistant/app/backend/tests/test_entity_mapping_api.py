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
) -> AsyncGenerator[tuple[AsyncClient, Database, EntityStateCache]]:
    database_path = tmp_path / "mapping-api.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")
    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    app = create_app(
        settings=Settings(data_dir=tmp_path, frontend_dist=tmp_path / "missing"),
        database=database,
    )
    cache: EntityStateCache = app.state.entity_state_cache
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client, database, cache


async def create_space(client: AsyncClient) -> str:
    response = await client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "North tent",
            "space_type": "tent",
            "dimensions": {
                "length": "80",
                "width": "80",
                "height": "180",
                "unit": "cm",
            },
        },
    )
    return str(response.json()["id"])


def mapping_url(grow_space_id: str) -> str:
    return f"/api/v1/grow-spaces/{grow_space_id}/entity-mappings"


async def test_multiple_entities_can_map_to_same_role(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache],
) -> None:
    client, _, _ = mapping_api
    grow_space_id = await create_space(client)

    first = await client.post(
        mapping_url(grow_space_id),
        json={
            "entity_id": "sensor.canopy_left",
            "role": "air_temperature",
            "priority": 10,
        },
    )
    second = await client.post(
        mapping_url(grow_space_id),
        json={
            "entity_id": "sensor.canopy_right",
            "role": "air_temperature",
            "priority": 20,
        },
    )

    assert first.status_code == second.status_code == 201


async def test_duplicate_entity_role_is_conflict(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache],
) -> None:
    client, _, _ = mapping_api
    grow_space_id = await create_space(client)
    payload = {"entity_id": "sensor.canopy_left", "role": "air_temperature"}

    assert (await client.post(mapping_url(grow_space_id), json=payload)).status_code == 201
    duplicate = await client.post(mapping_url(grow_space_id), json=payload)

    assert duplicate.status_code == 409


async def test_unknown_manual_entity_is_accepted_with_role_defaults(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache],
) -> None:
    client, _, _ = mapping_api
    grow_space_id = await create_space(client)

    response = await client.post(
        mapping_url(grow_space_id),
        json={"entity_id": "sensor.future_probe", "role": "air_temperature"},
    )

    assert response.status_code == 201
    assert response.json()["source_unit"] is None
    assert response.json()["normalized_unit"] == "°C"
    assert response.json()["stale_after_seconds"] == 300
    assert response.json()["compatibility"] == "unknown"


async def test_known_incompatible_entity_is_rejected(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache],
) -> None:
    client, _, cache = mapping_api
    cache.update(cached_state("sensor.bad_humidity", "800", "ppm", "humidity"))
    grow_space_id = await create_space(client)

    response = await client.post(
        mapping_url(grow_space_id),
        json={"entity_id": "sensor.bad_humidity", "role": "relative_humidity"},
    )

    assert response.status_code == 422


async def test_mapping_patch_delete_and_audit(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache],
) -> None:
    client, database, _ = mapping_api
    grow_space_id = await create_space(client)
    created = await client.post(
        mapping_url(grow_space_id),
        json={"entity_id": "sensor.canopy_left", "role": "air_temperature"},
    )
    mapping_id = created.json()["id"]

    updated = await client.patch(
        f"{mapping_url(grow_space_id)}/{mapping_id}",
        json={"enabled": False, "priority": 5},
    )
    deleted = await client.delete(f"{mapping_url(grow_space_id)}/{mapping_id}")

    async with database.transaction() as session:
        audit_count = await session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.resource_type == "entity_mapping")
        )

    assert not updated.json()["enabled"]
    assert updated.json()["priority"] == 5
    assert deleted.status_code == 204
    assert audit_count == 3


async def test_detail_normalizes_live_fahrenheit_reading(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache],
) -> None:
    client, _, cache = mapping_api
    cache.update(cached_state("sensor.tent_temp", "77", "°F", "temperature"))
    grow_space_id = await create_space(client)
    await client.post(
        mapping_url(grow_space_id),
        json={"entity_id": "sensor.tent_temp", "role": "air_temperature"},
    )

    response = await client.get(f"/api/v1/grow-spaces/{grow_space_id}")
    reading = response.json()["live_readings"][0]

    assert Decimal(str(reading["normalized_value"])) == Decimal("25")
    assert reading["normalized_unit"] == "°C"
    assert not reading["stale"]


async def test_inactive_space_mappings_remain_editable(
    mapping_api: tuple[AsyncClient, Database, EntityStateCache],
) -> None:
    client, _, _ = mapping_api
    grow_space_id = await create_space(client)
    await client.patch(
        f"/api/v1/grow-spaces/{grow_space_id}",
        json={"active": False},
    )

    created = await client.post(
        mapping_url(grow_space_id),
        json={"entity_id": "sensor.inactive_probe", "role": "air_temperature"},
    )
    mapping_id = created.json().get("id")
    updated = await client.patch(
        f"{mapping_url(grow_space_id)}/{mapping_id}",
        json={"priority": 5},
    )
    deleted = await client.delete(f"{mapping_url(grow_space_id)}/{mapping_id}")

    assert created.status_code == 201
    assert updated.status_code == 200
    assert updated.json()["priority"] == 5
    assert deleted.status_code == 204
