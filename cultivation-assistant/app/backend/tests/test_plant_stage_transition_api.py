# pyright: reportMissingImports=false
import pytest
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import PlantStageTransition
from httpx import AsyncClient
from sqlalchemy import func, select


async def _bootstrap(api_client: AsyncClient) -> dict[str, str]:
    space = await api_client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Trans tent",
            "space_type": "tent",
            "dimensions": {"length": "80", "width": "80", "height": "180", "unit": "cm"},
        },
    )
    grow = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": space.json()["id"],
            "name": "Trans grow",
            "status": "active",
            "start_date": "2026-07-23",
        },
    )
    cultivar = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "Trans cut", "breeder_id": None, "seed_type": "feminized"},
    )
    stages = (await api_client.get("/api/v1/lifecycle-stages")).json()["items"]
    stage_by_key = {item["key"]: item["id"] for item in stages}
    plant = await api_client.post(
        "/api/v1/plants",
        json={
            "grow_id": grow.json()["id"],
            "cultivar_id": cultivar.json()["id"],
            "name": "Trans plant",
            "propagation_source": "seed",
            "seed_type": "feminized",
            "current_stage_id": stage_by_key["seedling"],
            "status": "active",
            "start_date": "2026-07-23",
        },
    )
    return {
        "plant_id": plant.json()["id"],
        "seedling_id": stage_by_key["seedling"],
        "vegetative_id": stage_by_key["vegetative"],
        "flowering_id": stage_by_key["flowering"],
    }


@pytest.fixture
async def context(api_client: AsyncClient) -> dict[str, str]:
    return await _bootstrap(api_client)


async def test_adjacent_transition_needs_no_confirmation(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["vegetative_id"],
            "effective_at": "2026-07-24T10:00:00Z",
            "confirmed": False,
        },
    )
    assert response.status_code == 201
    assert response.json()["plant"]["current_stage"]["key"] == "vegetative"
    assert response.json()["transition"]["source"] == "user_confirmed"


async def test_skipped_transition_requires_confirmation(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["flowering_id"],
            "effective_at": "2026-07-24T10:00:00Z",
            "confirmed": False,
        },
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "transition_confirmation_required"


async def test_confirmed_skip_records_user_adjusted(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["flowering_id"],
            "effective_at": "2026-07-24T10:00:00Z",
            "confirmed": True,
        },
    )
    assert response.status_code == 201
    assert response.json()["transition"]["source"] == "user_adjusted"
    assert response.json()["plant"]["current_stage"]["key"] == "flowering"


async def test_backdated_transition_preserves_later_current_stage(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["flowering_id"],
            "effective_at": "2026-07-24T10:00:00Z",
            "confirmed": True,
        },
    )
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["vegetative_id"],
            "effective_at": "2026-06-01T10:00:00Z",
            "confirmed": True,
            "notes": "Imported earlier record",
        },
    )
    assert response.status_code == 201
    assert response.json()["plant"]["current_stage"]["key"] == "flowering"


async def test_transition_to_disabled_stage_is_rejected(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.patch(
        f"/api/v1/lifecycle-stages/{context['vegetative_id']}", json={"enabled": False}
    )
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["vegetative_id"],
            "effective_at": "2026-07-24T10:00:00Z",
            "confirmed": True,
        },
    )
    assert response.status_code == 422


async def test_history_is_append_only_and_ordered(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["vegetative_id"],
            "effective_at": "2026-07-24T10:00:00Z",
            "confirmed": True,
        },
    )
    detail = await api_client.get(f"/api/v1/plants/{context['plant_id']}")
    transitions = detail.json()["stage_transitions"]
    assert len(transitions) == 2
    assert [item["to_stage_id"] for item in transitions][-1] == context["vegetative_id"]


async def test_transition_writes_audit_row(
    api_client: AsyncClient, context: dict[str, str], database: Database
) -> None:
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/stage-transitions",
        json={
            "to_stage_id": context["vegetative_id"],
            "effective_at": "2026-07-24T10:00:00Z",
            "confirmed": True,
        },
    )
    async with database.transaction() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(PlantStageTransition)
            .where(PlantStageTransition.plant_id == context["plant_id"])
        )
    assert count == 2
