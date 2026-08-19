# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from cultivation_assistant.config import Settings
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import AuditLog, GrowSpace
from cultivation_assistant.main import create_app
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select


def grow_space_payload(name: str = "North tent") -> dict[str, object]:
    return {
        "name": name,
        "space_type": "tent",
        "dimensions": {
            "length": "80",
            "width": "80",
            "height": "180",
            "unit": "cm",
        },
    }


@pytest.fixture
async def api_client(tmp_path: Path) -> AsyncGenerator[tuple[AsyncClient, Database]]:
    database_path = tmp_path / "grow-space-api.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")

    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    app = create_app(
        settings=Settings(data_dir=tmp_path, frontend_dist=tmp_path / "missing"),
        database=database,
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client, database


async def test_create_and_list_details_only_grow_space(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, _ = api_client
    created = await client.post(
        "/api/v1/grow-spaces",
        json={**grow_space_payload(), "mappings": []},
        headers={"X-Correlation-ID": "create-space"},
    )

    assert created.status_code == 201
    grow_space = created.json()
    assert grow_space["name"] == "North tent"
    assert grow_space["active"]
    assert grow_space["mappings"] == []

    listed = await client.get("/api/v1/grow-spaces")
    assert [item["id"] for item in listed.json()["items"]] == [grow_space["id"]]


async def test_duplicate_active_name_is_conflict(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, _ = api_client
    payload = grow_space_payload()

    assert (await client.post("/api/v1/grow-spaces", json=payload)).status_code == 201
    duplicate = await client.post(
        "/api/v1/grow-spaces",
        json=grow_space_payload(" north TENT "),
    )

    assert duplicate.status_code == 409


async def test_update_deactivate_and_list_inactive_space(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, _ = api_client
    created = (
        await client.post(
            "/api/v1/grow-spaces",
            json=grow_space_payload(),
        )
    ).json()
    grow_space_id = created["id"]

    updated = await client.patch(
        f"/api/v1/grow-spaces/{grow_space_id}",
        json={"location": "Basement"},
    )
    deactivated = await client.delete(f"/api/v1/grow-spaces/{grow_space_id}")
    active_list = await client.get("/api/v1/grow-spaces")
    all_spaces = await client.get("/api/v1/grow-spaces?include_archived=true")
    inactive_update = await client.patch(
        f"/api/v1/grow-spaces/{grow_space_id}",
        json={"location": "Garage"},
    )

    assert updated.json()["location"] == "Basement"
    assert deactivated.status_code == 204
    assert active_list.json()["items"] == []
    assert not all_spaces.json()["items"][0]["active"]
    assert inactive_update.status_code == 200
    assert inactive_update.json()["location"] == "Garage"


async def test_missing_grow_space_is_not_found(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, _ = api_client

    response = await client.get("/api/v1/grow-spaces/missing")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


async def test_create_writes_audit_in_same_transaction(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, database = api_client
    response = await client.post(
        "/api/v1/grow-spaces",
        json=grow_space_payload(),
        headers={"X-Correlation-ID": "audit-create"},
    )

    async with database.transaction() as session:
        audit = (
            await session.execute(
                select(AuditLog.resource_id, AuditLog.correlation_id).where(
                    AuditLog.action == "grow_space.created"
                )
            )
        ).one()

    assert audit.resource_id == response.json()["id"]
    assert audit.correlation_id == "audit-create"


async def test_invalid_nested_mapping_rolls_back_space_and_audit(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, database = api_client
    response = await client.post(
        "/api/v1/grow-spaces",
        json={
            **grow_space_payload(),
            "mappings": [{"entity_id": "invalid", "role": "air_temperature"}],
        },
    )

    async with database.transaction() as session:
        grow_space_count = await session.scalar(select(func.count()).select_from(GrowSpace))
        audit_count = await session.scalar(select(func.count()).select_from(AuditLog))

    assert response.status_code == 422
    assert grow_space_count == 0
    assert audit_count == 0


async def test_dimensions_are_stored_and_measurements_are_derived(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, _ = api_client

    response = await client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Flower tent",
            "space_type": "tent",
            "dimensions": {
                "length": "80",
                "width": "80",
                "height": "180",
                "unit": "cm",
            },
        },
    )

    assert response.status_code == 201
    assert response.json()["dimensions"] == {
        "length": "80",
        "width": "80",
        "height": "180",
        "unit": "cm",
    }
    assert response.json()["area_m2"] == "0.6400"
    assert response.json()["volume_m3"] == "1.1520"


async def test_outdoor_space_allows_missing_height(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, _ = api_client

    response = await client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "South plot",
            "space_type": "outdoor",
            "dimensions": {
                "length": "200",
                "width": "300",
                "height": None,
                "unit": "cm",
            },
        },
    )

    assert response.status_code == 201
    assert response.json()["area_m2"] == "6.0000"
    assert response.json()["volume_m3"] is None


@pytest.mark.parametrize("space_type", ["tent", "greenhouse", "room"])
async def test_enclosed_space_requires_height(
    api_client: tuple[AsyncClient, Database],
    space_type: str,
) -> None:
    client, _ = api_client

    response = await client.post(
        "/api/v1/grow-spaces",
        json={
            "name": f"No-height {space_type}",
            "space_type": space_type,
            "dimensions": {
                "length": "80",
                "width": "80",
                "height": None,
                "unit": "cm",
            },
        },
    )

    assert response.status_code == 422


@pytest.mark.parametrize("space_type", ["cabinet", "hydroponic_system", "other"])
async def test_removed_space_types_are_rejected_for_creation(
    api_client: tuple[AsyncClient, Database],
    space_type: str,
) -> None:
    client, _ = api_client

    response = await client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Legacy type",
            "space_type": space_type,
            "dimensions": {
                "length": "80",
                "width": "80",
                "height": "180",
                "unit": "cm",
            },
        },
    )

    assert response.status_code == 422


async def test_legacy_space_remains_readable_without_dimensions(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, database = api_client
    async with database.transaction() as session:
        session.add(
            GrowSpace(
                id="legacy-space",
                name="Legacy cabinet",
                space_type="cabinet",
                active=True,
                area_m2=1.2,
                volume_m3=2.4,
            )
        )

    response = await client.get("/api/v1/grow-spaces/legacy-space")

    assert response.status_code == 200
    assert response.json()["space_type"] == "cabinet"
    assert response.json()["dimensions"] is None
    assert response.json()["area_m2"] == "1.2000"
    assert response.json()["volume_m3"] == "2.4000"


async def test_active_status_is_reversible_and_audited(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, database = api_client
    created = await client.post("/api/v1/grow-spaces", json=grow_space_payload())
    grow_space_id = created.json()["id"]

    inactive = await client.patch(
        f"/api/v1/grow-spaces/{grow_space_id}",
        json={"active": False},
    )
    edited = await client.patch(
        f"/api/v1/grow-spaces/{grow_space_id}",
        json={"location": "Garage"},
    )
    reactivated = await client.patch(
        f"/api/v1/grow-spaces/{grow_space_id}",
        json={"active": True},
    )

    async with database.transaction() as session:
        actions = list(
            await session.scalars(
                select(AuditLog.action)
                .where(AuditLog.resource_id == grow_space_id)
                .order_by(AuditLog.occurred_at)
            )
        )

    assert inactive.status_code == 200
    assert not inactive.json()["active"]
    assert edited.status_code == 200
    assert edited.json()["location"] == "Garage"
    assert reactivated.status_code == 200
    assert reactivated.json()["active"]
    assert actions == [
        "grow_space.created",
        "grow_space.deactivated",
        "grow_space.updated",
        "grow_space.reactivated",
    ]


async def test_reactivation_rejects_duplicate_active_name(
    api_client: tuple[AsyncClient, Database],
) -> None:
    client, _ = api_client
    original = await client.post("/api/v1/grow-spaces", json=grow_space_payload())
    original_id = original.json()["id"]
    await client.patch(f"/api/v1/grow-spaces/{original_id}", json={"active": False})
    duplicate = await client.post("/api/v1/grow-spaces", json=grow_space_payload())

    response = await client.patch(
        f"/api/v1/grow-spaces/{original_id}",
        json={"active": True},
    )

    assert duplicate.status_code == 201
    assert response.status_code == 409
    detail = await client.get(f"/api/v1/grow-spaces/{original_id}")
    assert not detail.json()["active"]
