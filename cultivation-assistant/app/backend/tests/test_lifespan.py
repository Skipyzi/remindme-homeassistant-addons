# pyright: reportMissingImports=false
from datetime import UTC, datetime
from pathlib import Path

import httpx
from cultivation_assistant.config import Settings
from cultivation_assistant.db.engine import Database
from cultivation_assistant.home_assistant.client import HomeAssistantClient
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.main import create_app
from cultivation_assistant.runtime import RuntimeStatus
from pydantic import SecretStr


async def test_lifespan_initializes_and_closes_database(tmp_path: Path) -> None:
    database_path = tmp_path / "lifespan.db"
    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    status = RuntimeStatus()
    app = create_app(
        runtime_status=status,
        settings=Settings(data_dir=tmp_path),
        database=database,
    )

    async with app.router.lifespan_context(app):
        assert status.database_ready
        assert database_path.exists()

    assert not status.database_ready


async def test_lifespan_validates_home_assistant_and_loads_states(tmp_path: Path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/"):
            return httpx.Response(200, json={"message": "API running."})
        return httpx.Response(
            200,
            json=[
                {
                    "entity_id": "sensor.temperature",
                    "state": "24.0",
                    "attributes": {},
                    "last_updated": datetime.now(UTC).isoformat(),
                }
            ],
        )

    http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(handler), base_url="http://supervisor/core"
    )
    status = RuntimeStatus()
    database = Database(f"sqlite+aiosqlite:///{(tmp_path / 'ha.db').as_posix()}")
    home_assistant = HomeAssistantClient(
        base_url="http://supervisor/core",
        token=SecretStr("secret"),
        state_cache=EntityStateCache(),
        runtime_status=status,
        http_client=http_client,
    )
    app = create_app(
        runtime_status=status,
        settings=Settings(data_dir=tmp_path),
        database=database,
        home_assistant_client=home_assistant,
    )

    async with app.router.lifespan_context(app):
        assert status.home_assistant_connected

    await http_client.aclose()
