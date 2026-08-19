# pyright: reportMissingImports=false
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import AuditLog, Cultivar, Grow, GrowSpace, Plant
from httpx import AsyncClient
from sqlalchemy import func, select


async def _all_stages(api_client: AsyncClient) -> list[dict[str, object]]:
    response = await api_client.get("/api/v1/lifecycle-stages?include_disabled=true")
    return response.json()["items"]


async def _create_custom_stage(api_client: AsyncClient, key: str = "mothering") -> str:
    response = await api_client.post(
        "/api/v1/lifecycle-stages",
        json={"key": key, "label": "Mothering"},
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


async def _seed_plant_on_stage(database: Database, stage_id: str) -> None:
    async with database.transaction() as session:
        session.add(GrowSpace(id="space-ref", name="Ref tent", space_type="tent", active=True))
        session.add(Cultivar(id="cultivar-ref", name="Ref cut", seed_type="unknown"))
        await session.flush()
        session.add(
            Grow(id="grow-ref", grow_space_id="space-ref", name="Ref grow", status="planned")
        )
        await session.flush()
        session.add(
            Plant(
                id="plant-ref",
                grow_id="grow-ref",
                cultivar_id="cultivar-ref",
                name="Ref plant",
                propagation_source="seed",
                current_stage_id=stage_id,
                status="planned",
            )
        )


async def test_lists_eleven_builtin_stages_in_order(api_client: AsyncClient) -> None:
    stages = await _all_stages(api_client)
    assert [item["key"] for item in stages] == [
        "seed",
        "germination",
        "seedling",
        "vegetative",
        "transition",
        "flowering",
        "finishing",
        "harvest",
        "drying",
        "curing",
        "completed",
    ]
    assert all(item["built_in"] for item in stages)


async def test_reorder_requires_complete_unique_stage_list(api_client: AsyncClient) -> None:
    stages = await _all_stages(api_client)
    reordered_ids = [stages[1]["id"], stages[0]["id"], *[item["id"] for item in stages[2:]]]
    response = await api_client.put(
        "/api/v1/lifecycle-stages/order",
        json={"stage_ids": reordered_ids},
    )
    assert response.status_code == 200
    items = response.json()["items"]
    assert [item["position"] for item in items] == list(range(len(stages)))
    assert [item["id"] for item in items] == reordered_ids


async def test_incomplete_order_is_rejected_and_unchanged(api_client: AsyncClient) -> None:
    stages = await _all_stages(api_client)
    response = await api_client.put(
        "/api/v1/lifecycle-stages/order",
        json={"stage_ids": [item["id"] for item in stages[:-1]]},
    )
    assert response.status_code == 422
    after = await _all_stages(api_client)
    assert [item["id"] for item in after] == [item["id"] for item in stages]


async def test_duplicate_order_ids_are_rejected(api_client: AsyncClient) -> None:
    stages = await _all_stages(api_client)
    ids = [item["id"] for item in stages]
    ids[1] = ids[0]
    response = await api_client.put(
        "/api/v1/lifecycle-stages/order",
        json={"stage_ids": ids},
    )
    assert response.status_code == 422


async def test_rename_builtin_keeps_stable_key(api_client: AsyncClient) -> None:
    stages = await _all_stages(api_client)
    seedling = next(item for item in stages if item["key"] == "seedling")
    response = await api_client.patch(
        f"/api/v1/lifecycle-stages/{seedling['id']}",
        json={"label": "Baby plant"},
    )
    assert response.status_code == 200
    assert response.json()["label"] == "Baby plant"
    assert response.json()["key"] == "seedling"


async def test_create_custom_stage_is_appended(api_client: AsyncClient) -> None:
    stage_id = await _create_custom_stage(api_client)
    stages = await _all_stages(api_client)
    created = next(item for item in stages if item["id"] == stage_id)
    assert created["built_in"] is False
    assert created["position"] == len(stages) - 1


async def test_duplicate_key_is_conflict(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/lifecycle-stages",
        json={"key": "seedling", "label": "Another seedling"},
    )
    assert response.status_code == 409


async def test_builtin_stage_can_be_disabled(api_client: AsyncClient) -> None:
    stages = await _all_stages(api_client)
    curing = next(item for item in stages if item["key"] == "curing")
    response = await api_client.patch(
        f"/api/v1/lifecycle-stages/{curing['id']}",
        json={"enabled": False},
    )
    assert response.status_code == 200
    assert response.json()["enabled"] is False


async def test_delete_unreferenced_custom_stage(api_client: AsyncClient) -> None:
    stage_id = await _create_custom_stage(api_client)
    response = await api_client.delete(f"/api/v1/lifecycle-stages/{stage_id}")
    assert response.status_code == 204


async def test_delete_builtin_stage_is_conflict(api_client: AsyncClient) -> None:
    stages = await _all_stages(api_client)
    response = await api_client.delete(f"/api/v1/lifecycle-stages/{stages[0]['id']}")
    assert response.status_code == 409


async def test_referenced_custom_stage_can_only_be_disabled(
    api_client: AsyncClient, database: Database
) -> None:
    stage_id = await _create_custom_stage(api_client)
    await _seed_plant_on_stage(database, stage_id)

    delete_response = await api_client.delete(f"/api/v1/lifecycle-stages/{stage_id}")
    disable_response = await api_client.patch(
        f"/api/v1/lifecycle-stages/{stage_id}",
        json={"enabled": False},
    )

    assert delete_response.status_code == 409
    assert disable_response.status_code == 200
    assert disable_response.json()["enabled"] is False


async def test_disabled_stage_remains_readable_in_history_listing(
    api_client: AsyncClient,
) -> None:
    stages = await _all_stages(api_client)
    finishing = next(item for item in stages if item["key"] == "finishing")
    await api_client.patch(
        f"/api/v1/lifecycle-stages/{finishing['id']}",
        json={"enabled": False},
    )

    enabled_only = (await api_client.get("/api/v1/lifecycle-stages")).json()["items"]
    including = await _all_stages(api_client)

    assert finishing["id"] not in {item["id"] for item in enabled_only}
    assert finishing["id"] in {item["id"] for item in including}


async def test_reorder_writes_single_audit_row(
    api_client: AsyncClient, database: Database
) -> None:
    stages = await _all_stages(api_client)
    ids = [item["id"] for item in stages]
    await api_client.put(
        "/api/v1/lifecycle-stages/order",
        json={"stage_ids": [ids[-1], *ids[:-1]]},
    )

    async with database.transaction() as session:
        count = await session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.action == "lifecycle_stage.reordered")
        )
    assert count == 1
