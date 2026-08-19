# pyright: reportMissingImports=false
import pytest
from httpx import AsyncClient


async def _bootstrap(api_client: AsyncClient) -> dict[str, str]:
    space = await api_client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Journal tent",
            "space_type": "tent",
            "dimensions": {"length": "80", "width": "80", "height": "180", "unit": "cm"},
        },
    )
    grow = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": space.json()["id"],
            "name": "Journal grow",
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
    plant = await api_client.post(
        "/api/v1/plants",
        json={
            "grow_id": grow.json()["id"],
            "cultivar_id": cultivar.json()["id"],
            "name": "North 1",
            "propagation_source": "seed",
            "seed_type": "feminized",
            "current_stage_id": stage_by_key["seedling"],
            "status": "active",
            "start_date": "2026-07-23",
        },
    )
    return {
        "grow_id": grow.json()["id"],
        "plant_id": plant.json()["id"],
        "seedling_id": stage_by_key["seedling"],
        "vegetative_id": stage_by_key["vegetative"],
    }


@pytest.fixture
async def context(api_client: AsyncClient) -> dict[str, str]:
    return await _bootstrap(api_client)


async def test_creates_a_plant_journal_entry(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/journal-entries",
        json={"entry_type": "note", "title": "Topped today", "tags": ["training"]},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["subject_type"] == "plant"
    assert body["subject_id"] == context["plant_id"]
    assert body["tags"] == ["training"]


async def test_creates_a_grow_journal_entry(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/grows/{context['grow_id']}/journal-entries",
        json={"entry_type": "note", "notes": "Reservoir topped off"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["subject_type"] == "grow"


async def test_unknown_plant_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/plants/missing/journal-entries", json={"entry_type": "note"}
    )
    assert response.status_code == 404


async def test_related_stage_is_rejected_for_a_grow_entry(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/grows/{context['grow_id']}/journal-entries",
        json={"entry_type": "note", "related_stage_id": context["seedling_id"]},
    )
    assert response.status_code == 422


async def test_unknown_related_stage_returns_404(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/journal-entries",
        json={"entry_type": "note", "related_stage_id": "missing"},
    )
    assert response.status_code == 404


async def test_creates_with_a_related_stage_and_returns_its_label(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/journal-entries",
        json={"entry_type": "topped", "related_stage_id": context["seedling_id"]},
    )
    assert response.status_code == 201, response.text
    assert response.json()["related_stage"]["key"] == "seedling"


async def test_lists_entries_for_a_plant_ordered_by_occurred_at_desc(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/journal-entries",
        json={"entry_type": "note", "occurred_at": "2026-07-20T10:00:00Z", "title": "Earlier"},
    )
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/journal-entries",
        json={"entry_type": "note", "occurred_at": "2026-07-24T10:00:00Z", "title": "Later"},
    )
    response = await api_client.get(f"/api/v1/plants/{context['plant_id']}/journal-entries")
    titles = [item["title"] for item in response.json()["items"]]
    assert titles == ["Later", "Earlier"]


async def test_updates_and_deletes_an_entry(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    created = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/journal-entries",
        json={"entry_type": "note", "title": "Original"},
    )
    entry_id = created.json()["id"]

    updated = await api_client.patch(
        f"/api/v1/journal-entries/{entry_id}", json={"title": "Revised"}
    )
    assert updated.status_code == 200
    assert updated.json()["title"] == "Revised"

    deleted = await api_client.delete(f"/api/v1/journal-entries/{entry_id}")
    assert deleted.status_code == 204

    listed = await api_client.get(f"/api/v1/plants/{context['plant_id']}/journal-entries")
    assert listed.json()["items"] == []


async def test_update_of_unknown_entry_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.patch("/api/v1/journal-entries/missing", json={"title": "x"})
    assert response.status_code == 404


async def test_naive_occurred_at_is_rejected(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/journal-entries",
        json={"entry_type": "note", "occurred_at": "2026-07-20T10:00:00"},
    )
    assert response.status_code == 422
