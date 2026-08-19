# pyright: reportMissingImports=false
import pytest
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import AuditLog, Plant
from httpx import AsyncClient
from sqlalchemy import func, select


async def _bootstrap(api_client: AsyncClient) -> dict[str, str]:
    space = await api_client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Plant tent",
            "space_type": "tent",
            "dimensions": {"length": "80", "width": "80", "height": "180", "unit": "cm"},
        },
    )
    grow = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": space.json()["id"],
            "name": "Plant grow",
            "status": "active",
            "start_date": "2026-07-23",
        },
    )
    cultivar = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "House cut", "breeder_id": None, "seed_type": "feminized"},
    )
    stages = (await api_client.get("/api/v1/lifecycle-stages")).json()["items"]
    stage_by_key = {item["key"]: item["id"] for item in stages}
    return {
        "grow_space_id": space.json()["id"],
        "grow_id": grow.json()["id"],
        "cultivar_id": cultivar.json()["id"],
        "seedling_id": stage_by_key["seedling"],
        "vegetative_id": stage_by_key["vegetative"],
        "flowering_id": stage_by_key["flowering"],
    }


@pytest.fixture
async def context(api_client: AsyncClient) -> dict[str, str]:
    return await _bootstrap(api_client)


def _plant_payload(context: dict[str, str], **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "grow_id": context["grow_id"],
        "cultivar_id": context["cultivar_id"],
        "name": "North 1",
        "propagation_source": "seed",
        "seed_type": "feminized",
        "current_stage_id": context["seedling_id"],
        "status": "active",
        "start_date": "2026-07-23",
    }
    payload.update(overrides)
    return payload


async def test_create_plant_atomically_adds_initial_transition(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post("/api/v1/plants", json=_plant_payload(context))
    assert response.status_code == 201, response.text
    plant = response.json()
    assert plant["current_stage"]["key"] == "seedling"
    assert len(plant["stage_transitions"]) == 1
    assert plant["stage_transitions"][0]["from_stage_id"] is None
    assert plant["stage_transitions"][0]["source"] == "user_confirmed"


async def test_clone_rejects_seed_type(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    payload = _plant_payload(context, propagation_source="clone", seed_type="feminized")
    response = await api_client.post("/api/v1/plants", json=payload)
    assert response.status_code == 422


async def test_clone_stores_null_seed_type(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    payload = _plant_payload(context, propagation_source="clone", seed_type=None)
    response = await api_client.post("/api/v1/plants", json=payload)
    assert response.status_code == 201
    assert response.json()["seed_type"] is None


async def test_active_plant_requires_start_date(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    payload = _plant_payload(context, status="active", start_date=None)
    response = await api_client.post("/api/v1/plants", json=payload)
    assert response.status_code == 422


async def test_actual_harvest_only_for_harvested_or_completed(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    payload = _plant_payload(context, status="active", actual_harvest_date="2026-10-01")
    response = await api_client.post("/api/v1/plants", json=payload)
    assert response.status_code == 422


async def test_inactive_cultivar_is_rejected(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.patch(f"/api/v1/cultivars/{context['cultivar_id']}", json={"active": False})
    response = await api_client.post("/api/v1/plants", json=_plant_payload(context))
    assert response.status_code == 422


async def test_missing_grow_is_not_found(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        "/api/v1/plants", json=_plant_payload(context, grow_id="missing")
    )
    assert response.status_code == 404


async def test_disabled_initial_stage_is_rejected(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.patch(
        f"/api/v1/lifecycle-stages/{context['vegetative_id']}", json={"enabled": False}
    )
    payload = _plant_payload(context, current_stage_id=context["vegetative_id"])
    response = await api_client.post("/api/v1/plants", json=payload)
    assert response.status_code == 422


async def test_duplicate_name_within_grow_is_conflict(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.post("/api/v1/plants", json=_plant_payload(context, name="North 1"))
    response = await api_client.post(
        "/api/v1/plants", json=_plant_payload(context, name=" north 1 ")
    )
    assert response.status_code == 409


async def test_filters_by_status_and_grow(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.post("/api/v1/plants", json=_plant_payload(context, name="Active one"))
    await api_client.post(
        "/api/v1/plants",
        json=_plant_payload(context, name="Planned one", status="planned", start_date=None),
    )

    planned = await api_client.get(
        f"/api/v1/plants?grow_id={context['grow_id']}&status=planned"
    )
    names = {item["name"] for item in planned.json()["items"]}
    assert names == {"Planned one"}


async def test_archive_and_restore_plant(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    created = await api_client.post("/api/v1/plants", json=_plant_payload(context))
    plant_id = created.json()["id"]

    archived = await api_client.delete(f"/api/v1/plants/{plant_id}")
    default_list = await api_client.get(f"/api/v1/plants?grow_id={context['grow_id']}")
    restored = await api_client.patch(
        f"/api/v1/plants/{plant_id}", json={"status": "active"}
    )

    assert archived.status_code == 204
    assert default_list.json()["items"] == []
    assert restored.status_code == 200
    assert restored.json()["status"] == "active"


async def test_create_writes_audit_and_transition_atomically(
    api_client: AsyncClient, context: dict[str, str], database: Database
) -> None:
    response = await api_client.post("/api/v1/plants", json=_plant_payload(context))
    plant_id = response.json()["id"]

    async with database.transaction() as session:
        action = await session.scalar(
            select(AuditLog.action).where(AuditLog.resource_id == plant_id)
        )
    assert action == "plant.created"


async def test_conflict_rolls_back_without_plant_row(
    api_client: AsyncClient, context: dict[str, str], database: Database
) -> None:
    await api_client.post("/api/v1/plants", json=_plant_payload(context, name="Rollback"))
    await api_client.post("/api/v1/plants", json=_plant_payload(context, name="Rollback"))

    async with database.transaction() as session:
        count = await session.scalar(
            select(func.count()).select_from(Plant).where(Plant.name == "Rollback")
        )
    assert count == 1
