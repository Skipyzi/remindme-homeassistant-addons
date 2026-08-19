from cultivation_assistant.main import create_app
from httpx import ASGITransport, AsyncClient


async def test_health_reports_application_version() -> None:
    app = create_app()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "healthy",
        "version": "0.6.0",
    }
