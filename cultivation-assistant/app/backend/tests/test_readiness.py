from cultivation_assistant.main import create_app
from cultivation_assistant.runtime import RuntimeStatus
from httpx import ASGITransport, AsyncClient


async def test_readiness_reports_unavailable_dependencies() -> None:
    status = RuntimeStatus(database_ready=False, home_assistant_connected=False)
    app = create_app(runtime_status=status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/readiness")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "checks": {"database": "unavailable", "home_assistant": "unavailable"},
    }


async def test_readiness_succeeds_when_dependencies_are_ready() -> None:
    status = RuntimeStatus(database_ready=True, home_assistant_connected=True)
    app = create_app(runtime_status=status)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/readiness")

    assert response.status_code == 200
    assert response.json()["status"] == "ready"
