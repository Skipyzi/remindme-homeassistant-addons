from cultivation_assistant.config import Settings
from cultivation_assistant.main import create_app
from cultivation_assistant.runtime import RuntimeStatus
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr


async def test_diagnostics_exposes_health_without_secrets() -> None:
    settings = Settings(supervisor_token=SecretStr("must-not-leak"))
    status = RuntimeStatus(
        database_ready=True,
        home_assistant_connected=False,
        schema_version="0001",
    )
    app = create_app(runtime_status=status, settings=settings)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/diagnostics")

    assert response.status_code == 200
    assert response.json() == {
        "app_version": "0.6.0",
        "schema_version": "0001",
        "database": "ready",
        "home_assistant": "unavailable",
    }
    assert "must-not-leak" not in response.text
