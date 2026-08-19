from pathlib import Path

from cultivation_assistant.config import Settings
from cultivation_assistant.main import create_app
from httpx import ASGITransport, AsyncClient


async def test_app_serves_bundled_frontend_when_available(tmp_path: Path) -> None:
    frontend_dist = tmp_path / "frontend"
    frontend_dist.mkdir()
    (frontend_dist / "index.html").write_text("<h1>Cultivation Assistant</h1>", encoding="utf-8")
    app = create_app(settings=Settings(data_dir=tmp_path, frontend_dist=frontend_dist))

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/")

    assert response.status_code == 200
    assert "Cultivation Assistant" in response.text
