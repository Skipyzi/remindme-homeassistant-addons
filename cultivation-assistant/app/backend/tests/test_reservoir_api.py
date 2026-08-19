# pyright: reportMissingImports=false
from httpx import AsyncClient


def _rectangular_payload(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
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
    }
    payload.update(overrides)
    return payload


async def test_creates_a_rectangular_reservoir(api_client: AsyncClient) -> None:
    response = await api_client.post("/api/v1/reservoirs", json=_rectangular_payload())
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Mixing tank"
    assert body["geometry"]["shape"] == "rectangular"
    assert body["geometry"]["length"] == "50"


async def test_creates_a_calibration_table_reservoir_without_dimensions(
    api_client: AsyncClient,
) -> None:
    response = await api_client.post(
        "/api/v1/reservoirs",
        json=_rectangular_payload(
            geometry={"shape": "custom_calibration_table"}
        ),
    )
    assert response.status_code == 201, response.text
    assert response.json()["geometry"]["unit"] is None


async def test_rejects_incomplete_geometry_for_rectangular(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/reservoirs",
        json=_rectangular_payload(
            geometry={"shape": "rectangular", "unit": "cm", "length": "50"}
        ),
    )
    assert response.status_code == 422


async def test_rejects_usable_capacity_above_capacity(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/reservoirs",
        json=_rectangular_payload(capacity_liters="50", usable_capacity_liters="60"),
    )
    assert response.status_code == 422


async def test_rejects_duplicate_active_name(api_client: AsyncClient) -> None:
    await api_client.post("/api/v1/reservoirs", json=_rectangular_payload())
    response = await api_client.post("/api/v1/reservoirs", json=_rectangular_payload())
    assert response.status_code == 409


async def test_unknown_primary_grow_space_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/reservoirs",
        json=_rectangular_payload(primary_grow_space_id="missing"),
    )
    assert response.status_code == 404


async def test_lists_and_gets_a_reservoir(api_client: AsyncClient) -> None:
    created = await api_client.post("/api/v1/reservoirs", json=_rectangular_payload())
    reservoir_id = created.json()["id"]

    listed = await api_client.get("/api/v1/reservoirs")
    assert len(listed.json()["items"]) == 1

    fetched = await api_client.get(f"/api/v1/reservoirs/{reservoir_id}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == reservoir_id


async def test_updates_geometry_and_capacity(api_client: AsyncClient) -> None:
    created = await api_client.post("/api/v1/reservoirs", json=_rectangular_payload())
    reservoir_id = created.json()["id"]

    updated = await api_client.patch(
        f"/api/v1/reservoirs/{reservoir_id}",
        json={
            "capacity_liters": "200",
            "geometry": {
                "shape": "vertical_cylinder",
                "unit": "cm",
                "diameter": "40",
                "height": "80",
            },
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()
    assert body["capacity_liters"] == "200"
    assert body["geometry"]["shape"] == "vertical_cylinder"
    assert body["geometry"]["diameter"] == "40"


async def test_archive_and_restore_preserve_the_record(api_client: AsyncClient) -> None:
    created = await api_client.post("/api/v1/reservoirs", json=_rectangular_payload())
    reservoir_id = created.json()["id"]

    archived = await api_client.delete(f"/api/v1/reservoirs/{reservoir_id}")
    assert archived.status_code == 204

    listed = await api_client.get("/api/v1/reservoirs")
    assert listed.json()["items"] == []

    listed_with_archived = await api_client.get("/api/v1/reservoirs?include_archived=true")
    assert len(listed_with_archived.json()["items"]) == 1
    assert listed_with_archived.json()["items"][0]["active"] is False

    restored = await api_client.patch(
        f"/api/v1/reservoirs/{reservoir_id}", json={"active": True}
    )
    assert restored.status_code == 200
    assert restored.json()["active"] is True


async def test_unknown_reservoir_returns_404(api_client: AsyncClient) -> None:
    response = await api_client.get("/api/v1/reservoirs/missing")
    assert response.status_code == 404
