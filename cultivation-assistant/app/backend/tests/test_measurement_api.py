# pyright: reportMissingImports=false
import pytest
from httpx import AsyncClient


async def _bootstrap(api_client: AsyncClient) -> dict[str, str]:
    space = await api_client.post(
        "/api/v1/grow-spaces",
        json={
            "name": "Measurement tent",
            "space_type": "tent",
            "dimensions": {"length": "80", "width": "80", "height": "180", "unit": "cm"},
        },
    )
    grow = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": space.json()["id"],
            "name": "Measurement grow",
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
    return {"plant_id": plant.json()["id"]}


@pytest.fixture
async def context(api_client: AsyncClient) -> dict[str, str]:
    return await _bootstrap(api_client)


async def test_creates_a_height_measurement(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/measurements",
        json={"metric_type": "height", "value": 32.5, "unit": "cm"},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["metric_type"] == "height"
    assert body["value"] == 32.5


async def test_custom_metric_requires_a_name(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/measurements",
        json={"metric_type": "custom", "value": 6.2, "unit": "brix"},
    )
    assert response.status_code == 422


async def test_custom_metric_with_a_name_succeeds(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    response = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/measurements",
        json={
            "metric_type": "custom",
            "custom_metric_name": "Brix",
            "value": 6.2,
            "unit": "brix",
        },
    )
    assert response.status_code == 201, response.text
    assert response.json()["custom_metric_name"] == "Brix"


async def test_unknown_plant_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/plants/missing/measurements",
        json={"metric_type": "height", "value": 1, "unit": "cm"},
    )
    assert response.status_code == 404


async def test_lists_measurements_ordered_by_occurred_at_desc(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/measurements",
        json={
            "metric_type": "height",
            "value": 10,
            "unit": "cm",
            "occurred_at": "2026-07-20T10:00:00Z",
        },
    )
    await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/measurements",
        json={
            "metric_type": "height",
            "value": 20,
            "unit": "cm",
            "occurred_at": "2026-07-24T10:00:00Z",
        },
    )
    response = await api_client.get(f"/api/v1/plants/{context['plant_id']}/measurements")
    values = [item["value"] for item in response.json()["items"]]
    assert values == [20, 10]


async def test_updates_and_deletes_a_measurement(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    created = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/measurements",
        json={"metric_type": "height", "value": 10, "unit": "cm"},
    )
    measurement_id = created.json()["id"]

    updated = await api_client.patch(
        f"/api/v1/measurements/{measurement_id}", json={"value": 15}
    )
    assert updated.status_code == 200
    assert updated.json()["value"] == 15

    deleted = await api_client.delete(f"/api/v1/measurements/{measurement_id}")
    assert deleted.status_code == 204

    listed = await api_client.get(f"/api/v1/plants/{context['plant_id']}/measurements")
    assert listed.json()["items"] == []


async def test_update_of_unknown_measurement_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.patch("/api/v1/measurements/missing", json={"value": 1})
    assert response.status_code == 404


async def test_update_to_custom_without_name_is_rejected(
    api_client: AsyncClient, context: dict[str, str]
) -> None:
    created = await api_client.post(
        f"/api/v1/plants/{context['plant_id']}/measurements",
        json={"metric_type": "height", "value": 10, "unit": "cm"},
    )
    measurement_id = created.json()["id"]
    response = await api_client.patch(
        f"/api/v1/measurements/{measurement_id}", json={"metric_type": "custom"}
    )
    assert response.status_code == 422
