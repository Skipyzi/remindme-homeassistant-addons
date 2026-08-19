# pyright: reportMissingImports=false
import pytest
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import AuditLog
from httpx import AsyncClient
from sqlalchemy import func, select


async def _create_space(api_client: AsyncClient, name: str = "North tent") -> str:
    response = await api_client.post(
        "/api/v1/grow-spaces",
        json={
            "name": name,
            "space_type": "tent",
            "dimensions": {"length": "80", "width": "80", "height": "180", "unit": "cm"},
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


@pytest.fixture
async def grow_space_id(api_client: AsyncClient) -> str:
    return await _create_space(api_client)


async def _create_grow(
    api_client: AsyncClient, grow_space_id: str, name: str, **overrides: object
) -> dict[str, object]:
    payload: dict[str, object] = {
        "grow_space_id": grow_space_id,
        "name": name,
        "status": "active",
        "start_date": "2026-07-23",
    }
    payload.update(overrides)
    response = await api_client.post("/api/v1/grows", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


async def test_multiple_active_grows_can_share_one_space(
    api_client: AsyncClient, grow_space_id: str
) -> None:
    for name in ("Summer run", "Mother stock"):
        response = await api_client.post(
            "/api/v1/grows",
            json={
                "grow_space_id": grow_space_id,
                "name": name,
                "status": "active",
                "start_date": "2026-07-23",
            },
        )
        assert response.status_code == 201


async def test_active_grow_requires_start_date(
    api_client: AsyncClient, grow_space_id: str
) -> None:
    response = await api_client.post(
        "/api/v1/grows",
        json={"grow_space_id": grow_space_id, "name": "No date", "status": "active"},
    )
    assert response.status_code == 422


async def test_end_date_cannot_precede_start(
    api_client: AsyncClient, grow_space_id: str
) -> None:
    response = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": grow_space_id,
            "name": "Backwards",
            "status": "active",
            "start_date": "2026-07-23",
            "end_date": "2026-07-01",
        },
    )
    assert response.status_code == 422


async def test_create_in_unknown_space_is_not_found(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/grows",
        json={"grow_space_id": "missing", "name": "Orphan", "status": "planned"},
    )
    assert response.status_code == 404


async def test_duplicate_active_name_within_space_is_conflict(
    api_client: AsyncClient, grow_space_id: str
) -> None:
    await _create_grow(api_client, grow_space_id, "Summer run")
    response = await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": grow_space_id,
            "name": "  summer RUN ",
            "status": "active",
            "start_date": "2026-07-23",
        },
    )
    assert response.status_code == 409


async def test_inactive_space_creation_warns(api_client: AsyncClient) -> None:
    space_id = await _create_space(api_client, "Retiring tent")
    await api_client.delete(f"/api/v1/grow-spaces/{space_id}")

    response = await api_client.post(
        "/api/v1/grows",
        json={"grow_space_id": space_id, "name": "Ghost grow", "status": "planned"},
    )

    assert response.status_code == 201
    assert response.json()["grow_space_active"] is False


async def test_list_reports_plant_counts_and_status_summary(
    api_client: AsyncClient, grow_space_id: str, database: Database
) -> None:
    from cultivation_assistant.db.models import Cultivar, LifecycleStage, Plant
    from sqlalchemy import select as sa_select

    grow = await _create_grow(api_client, grow_space_id, "Counting grow")
    async with database.transaction() as session:
        stage_id = await session.scalar(
            sa_select(LifecycleStage.id).where(LifecycleStage.key == "seedling")
        )
        session.add(Cultivar(id="cultivar-count", name="Counter", seed_type="unknown"))
        await session.flush()
        for index, plant_status in enumerate(("active", "active", "planned")):
            session.add(
                Plant(
                    id=f"plant-count-{index}",
                    grow_id=grow["id"],
                    cultivar_id="cultivar-count",
                    name=f"P{index}",
                    propagation_source="seed",
                    current_stage_id=stage_id,
                    status=plant_status,
                )
            )

    listed = await api_client.get(f"/api/v1/grows?grow_space_id={grow_space_id}")
    summary = next(item for item in listed.json()["items"] if item["id"] == grow["id"])
    assert summary["plant_count"] == 3
    assert summary["plant_status_counts"]["active"] == 2
    assert summary["plant_status_counts"]["planned"] == 1


async def test_status_filter_selects_matching_grows(
    api_client: AsyncClient, grow_space_id: str
) -> None:
    await _create_grow(api_client, grow_space_id, "Active grow", status="active")
    await api_client.post(
        "/api/v1/grows",
        json={"grow_space_id": grow_space_id, "name": "Planned grow", "status": "planned"},
    )

    planned = await api_client.get("/api/v1/grows?status=planned")
    names = {item["name"] for item in planned.json()["items"]}
    assert names == {"Planned grow"}


async def test_archive_is_idempotent_and_excluded_by_default(
    api_client: AsyncClient, grow_space_id: str
) -> None:
    grow = await _create_grow(api_client, grow_space_id, "Archivable")

    first = await api_client.delete(f"/api/v1/grows/{grow['id']}")
    second = await api_client.delete(f"/api/v1/grows/{grow['id']}")
    default_list = await api_client.get("/api/v1/grows")
    including = await api_client.get("/api/v1/grows?include_archived=true")

    assert first.status_code == 204
    assert second.status_code == 204
    assert default_list.json()["items"] == []
    assert [item["id"] for item in including.json()["items"]] == [grow["id"]]


async def test_restore_rechecks_name_uniqueness(
    api_client: AsyncClient, grow_space_id: str
) -> None:
    archived = await _create_grow(api_client, grow_space_id, "Summer run")
    await api_client.delete(f"/api/v1/grows/{archived['id']}")
    await _create_grow(api_client, grow_space_id, "Summer run")

    response = await api_client.patch(
        f"/api/v1/grows/{archived['id']}",
        json={"status": "active", "start_date": "2026-07-23"},
    )
    assert response.status_code == 409


async def test_get_missing_grow_is_not_found(api_client: AsyncClient) -> None:
    response = await api_client.get("/api/v1/grows/missing")
    assert response.status_code == 404


async def test_create_writes_audit_row(
    api_client: AsyncClient, grow_space_id: str, database: Database
) -> None:
    grow = await _create_grow(api_client, grow_space_id, "Audited grow")

    async with database.transaction() as session:
        action = await session.scalar(
            select(AuditLog.action).where(AuditLog.resource_id == grow["id"])
        )
    assert action == "grow.created"


async def test_conflict_rolls_back_without_audit(
    api_client: AsyncClient, grow_space_id: str, database: Database
) -> None:
    await _create_grow(api_client, grow_space_id, "Rollback grow")
    await api_client.post(
        "/api/v1/grows",
        json={
            "grow_space_id": grow_space_id,
            "name": "Rollback grow",
            "status": "active",
            "start_date": "2026-07-23",
        },
    )

    async with database.transaction() as session:
        created = await session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.action == "grow.created")
        )
    assert created == 1
