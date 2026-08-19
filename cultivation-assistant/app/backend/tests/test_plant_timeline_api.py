# pyright: reportMissingImports=false
import base64

import pytest
from httpx import AsyncClient

PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


async def _bootstrap(api_client: AsyncClient) -> dict[str, str]:
    space = await api_client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Timeline tent",
            "space_type": "tent",
            "dimensions": {"length": "80", "width": "80", "height": "180", "unit": "cm"},
        },
    )
    grow = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": space.json()["id"],
            "name": "Timeline grow",
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
            "start_date": "2026-07-20",
        },
    )
    return {"plant_id": plant.json()["id"]}


@pytest.fixture
async def context(api_client: AsyncClient) -> dict[str, str]:
    return await _bootstrap(api_client)


async def test_timeline_merges_all_sources_in_order(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    plant_id = context["plant_id"]
    await api_client.post(
        f"/api/v1/plants/{plant_id}/journal-entries",
        json={
            "entry_type": "note",
            "title": "Topped",
            "occurred_at": "2026-07-22T10:00:00Z",
        },
    )
    await api_client.post(
        f"/api/v1/plants/{plant_id}/measurements",
        json={
            "metric_type": "height",
            "value": 12,
            "unit": "cm",
            "occurred_at": "2026-07-23T10:00:00Z",
        },
    )
    await api_client.post(
        f"/api/v1/plants/{plant_id}/photos",
        files={"file": ("leaf.png", PNG_1X1, "image/png")},
        data={"occurred_at": "2026-07-24T10:00:00Z"},
    )

    response = await api_client.get(f"/api/v1/plants/{plant_id}/timeline")
    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["event_type"] for item in items] == [
        "photo_added",
        "measurement_recorded",
        "note",
        "stage_changed",
    ]


async def test_each_entry_populates_exactly_one_detail_field(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    plant_id = context["plant_id"]
    await api_client.post(
        f"/api/v1/plants/{plant_id}/journal-entries",
        json={"entry_type": "note", "title": "Topped"},
    )
    response = await api_client.get(f"/api/v1/plants/{plant_id}/timeline")
    for item in response.json()["items"]:
        detail_fields = ["journal_entry", "measurement", "photo", "stage_transition"]
        populated = [field for field in detail_fields if item[field] is not None]
        assert len(populated) == 1


async def test_stage_transition_entry_has_a_summary(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.get(f"/api/v1/plants/{context['plant_id']}/timeline")
    stage_entry = next(
        item for item in response.json()["items"] if item["event_type"] == "stage_changed"
    )
    assert "Seedling" in stage_entry["summary"]
    assert stage_entry["stage_transition"]["to_stage"]["key"] == "seedling"


async def test_timeline_paginates(api_client: AsyncClient, context: dict[str, str]) -> None:
    plant_id = context["plant_id"]
    for day in range(3):
        await api_client.post(
            f"/api/v1/plants/{plant_id}/journal-entries",
            json={
                "entry_type": "note",
                "title": f"Day {day}",
                "occurred_at": f"2026-07-{20 + day:02d}T10:00:00Z",
            },
        )
    response = await api_client.get(f"/api/v1/plants/{plant_id}/timeline?limit=2&offset=0")
    assert len(response.json()["items"]) == 2


async def test_unknown_plant_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.get("/api/v1/plants/missing/timeline")
    assert response.status_code == 404
