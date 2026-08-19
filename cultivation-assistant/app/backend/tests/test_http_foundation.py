from cultivation_assistant.main import create_app
from httpx import ASGITransport, AsyncClient


async def test_responses_include_correlation_id() -> None:
    app = create_app()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/health", headers={"X-Correlation-ID": "request-123"})

    assert response.headers["X-Correlation-ID"] == "request-123"


async def test_unknown_route_uses_consistent_error_shape() -> None:
    app = create_app()

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/not-found")

    assert response.status_code == 404
    assert response.json() == {
        "error": {
            "code": "not_found",
            "message": "The requested resource was not found.",
            "details": {},
        }
    }
