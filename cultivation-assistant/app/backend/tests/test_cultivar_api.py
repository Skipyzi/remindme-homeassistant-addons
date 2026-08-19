# pyright: reportMissingImports=false
from cultivation_assistant.db.engine import Database
from cultivation_assistant.db.models import AuditLog
from httpx import AsyncClient
from sqlalchemy import func, select


async def test_create_cultivar_without_breeder(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "Mystery Cut", "breeder_id": None, "seed_type": "unknown"},
    )
    assert response.status_code == 201
    assert response.json()["breeder"] is None
    assert response.json()["seed_type"] == "unknown"


async def test_duplicate_breederless_cultivar_is_conflict(api_client: AsyncClient) -> None:
    payload = {"name": "Mystery Cut", "breeder_id": None, "seed_type": "unknown"}
    assert (await api_client.post("/api/v1/cultivars", json=payload)).status_code == 201
    duplicate = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "  mystery cut ", "breeder_id": None, "seed_type": "unknown"},
    )
    assert duplicate.status_code == 409


async def test_create_cultivar_with_breeder_nests_identity(api_client: AsyncClient) -> None:
    breeder = await api_client.post("/api/v1/breeders", json={"name": "Sensi Seeds"})
    assert breeder.status_code == 201
    breeder_id = breeder.json()["id"]

    response = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "Northern Lights", "breeder_id": breeder_id, "seed_type": "feminized"},
    )

    assert response.status_code == 201
    assert response.json()["breeder"] == {"id": breeder_id, "name": "Sensi Seeds"}


async def test_same_name_differs_by_breeder(api_client: AsyncClient) -> None:
    first = (await api_client.post("/api/v1/breeders", json={"name": "Breeder A"})).json()
    second = (await api_client.post("/api/v1/breeders", json={"name": "Breeder B"})).json()
    payload_a = {"name": "Northern Lights", "breeder_id": first["id"], "seed_type": "regular"}
    payload_b = {"name": "Northern Lights", "breeder_id": second["id"], "seed_type": "regular"}

    assert (await api_client.post("/api/v1/cultivars", json=payload_a)).status_code == 201
    assert (await api_client.post("/api/v1/cultivars", json=payload_b)).status_code == 201


async def test_cultivar_with_unknown_breeder_is_not_found(api_client: AsyncClient) -> None:
    response = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "Ghost", "breeder_id": "missing", "seed_type": "unknown"},
    )
    assert response.status_code == 404


async def test_inactive_cultivar_is_filtered_by_default(api_client: AsyncClient) -> None:
    created = (
        await api_client.post(
            "/api/v1/cultivars",
            json={"name": "Retiring Cut", "breeder_id": None, "seed_type": "unknown"},
        )
    ).json()
    await api_client.patch(f"/api/v1/cultivars/{created['id']}", json={"active": False})

    active_only = await api_client.get("/api/v1/cultivars")
    including = await api_client.get("/api/v1/cultivars?include_inactive=true")

    assert active_only.json()["items"] == []
    assert [item["id"] for item in including.json()["items"]] == [created["id"]]


async def test_reactivation_rejects_duplicate_identity(api_client: AsyncClient) -> None:
    original = (
        await api_client.post(
            "/api/v1/cultivars",
            json={"name": "Duplicate Cut", "breeder_id": None, "seed_type": "unknown"},
        )
    ).json()
    await api_client.patch(f"/api/v1/cultivars/{original['id']}", json={"active": False})
    await api_client.post(
        "/api/v1/cultivars",
        json={"name": "Duplicate Cut", "breeder_id": None, "seed_type": "unknown"},
    )

    response = await api_client.patch(
        f"/api/v1/cultivars/{original['id']}",
        json={"active": True},
    )
    assert response.status_code == 409


async def test_patch_missing_cultivar_is_not_found(api_client: AsyncClient) -> None:
    response = await api_client.patch("/api/v1/cultivars/missing", json={"name": "New"})
    assert response.status_code == 404


async def test_query_filters_cultivars_by_name(api_client: AsyncClient) -> None:
    for name in ("Blue Dream", "Blueberry", "Gelato"):
        await api_client.post(
            "/api/v1/cultivars",
            json={"name": name, "breeder_id": None, "seed_type": "unknown"},
        )

    response = await api_client.get("/api/v1/cultivars?query=blue")

    names = {item["name"] for item in response.json()["items"]}
    assert names == {"Blue Dream", "Blueberry"}


async def test_create_writes_audit_row(
    api_client: AsyncClient, database: Database
) -> None:
    response = await api_client.post(
        "/api/v1/cultivars",
        json={"name": "Audited Cut", "breeder_id": None, "seed_type": "unknown"},
        headers={"X-Correlation-ID": "cultivar-create"},
    )

    async with database.transaction() as session:
        audit = (
            await session.execute(
                select(AuditLog.resource_id, AuditLog.correlation_id).where(
                    AuditLog.action == "cultivar.created"
                )
            )
        ).one()

    assert audit.resource_id == response.json()["id"]
    assert audit.correlation_id == "cultivar-create"


async def test_conflict_rolls_back_without_audit(
    api_client: AsyncClient, database: Database
) -> None:
    payload = {"name": "Rollback Cut", "breeder_id": None, "seed_type": "unknown"}
    await api_client.post("/api/v1/cultivars", json=payload)
    await api_client.post("/api/v1/cultivars", json=payload)

    async with database.transaction() as session:
        created_audits = await session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.action == "cultivar.created")
        )

    assert created_audits == 1
