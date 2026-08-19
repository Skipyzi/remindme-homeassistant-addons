# pyright: reportMissingImports=false
import pytest
from httpx import AsyncClient


@pytest.fixture
async def seeded_reservoir(api_client: AsyncClient) -> str:
    response = await api_client.post(
        "/api/v1/reservoirs",
        json={
            "name": "Custom tank",
            "reservoir_type": "custom_reservoir",
            "capacity_liters": "200",
            "geometry": {"shape": "custom_calibration_table"},
        },
    )
    return response.json()["id"]


async def test_replaces_the_full_calibration_table(
    api_client: AsyncClient, seeded_reservoir: str
) -> None:
    response = await api_client.put(
        f"/api/v1/reservoirs/{seeded_reservoir}/calibration-points",
        json={
            "points": [
                {"raw_value": "0", "volume_liters": "0"},
                {"raw_value": "100", "volume_liters": "200"},
            ]
        },
    )
    assert response.status_code == 200, response.text
    assert len(response.json()["items"]) == 2


async def test_requires_at_least_two_points(
    api_client: AsyncClient, seeded_reservoir: str
) -> None:
    response = await api_client.put(
        f"/api/v1/reservoirs/{seeded_reservoir}/calibration-points",
        json={"points": [{"raw_value": "0", "volume_liters": "0"}]},
    )
    assert response.status_code == 422


async def test_rejects_duplicate_raw_values(
    api_client: AsyncClient, seeded_reservoir: str
) -> None:
    response = await api_client.put(
        f"/api/v1/reservoirs/{seeded_reservoir}/calibration-points",
        json={
            "points": [
                {"raw_value": "0", "volume_liters": "0"},
                {"raw_value": "0", "volume_liters": "10"},
            ]
        },
    )
    assert response.status_code == 422


async def test_replace_is_idempotent_and_replaces_prior_points(
    api_client: AsyncClient, seeded_reservoir: str
) -> None:
    await api_client.put(
        f"/api/v1/reservoirs/{seeded_reservoir}/calibration-points",
        json={
            "points": [
                {"raw_value": "0", "volume_liters": "0"},
                {"raw_value": "50", "volume_liters": "100"},
                {"raw_value": "100", "volume_liters": "200"},
            ]
        },
    )
    second = await api_client.put(
        f"/api/v1/reservoirs/{seeded_reservoir}/calibration-points",
        json={
            "points": [
                {"raw_value": "0", "volume_liters": "0"},
                {"raw_value": "100", "volume_liters": "150"},
            ]
        },
    )
    assert len(second.json()["items"]) == 2

    listed = await api_client.get(
        f"/api/v1/reservoirs/{seeded_reservoir}/calibration-points"
    )
    assert len(listed.json()["items"]) == 2
    assert listed.json()["items"][1]["volume_liters"] == "150.0000"


async def test_unknown_reservoir_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.put(
        "/api/v1/reservoirs/missing/calibration-points",
        json={
            "points": [
                {"raw_value": "0", "volume_liters": "0"},
                {"raw_value": "1", "volume_liters": "1"},
            ]
        },
    )
    assert response.status_code == 404
