# pyright: reportMissingImports=false
"""Shared fixtures for cultivation-record API tests."""

from collections.abc import AsyncGenerator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from cultivation_assistant.config import Settings
from cultivation_assistant.db.engine import Database
from cultivation_assistant.main import create_app
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def api_env(tmp_path: Path) -> AsyncGenerator[tuple[AsyncClient, Database]]:
    """Yield an ASGI client and its database over a freshly migrated schema."""
    database_path = tmp_path / "api.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")

    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    app = create_app(
        settings=Settings(data_dir=tmp_path, frontend_dist=tmp_path / "missing"),
        database=database,
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            yield client, database


@pytest.fixture
async def api_client(api_env: tuple[AsyncClient, Database]) -> AsyncClient:
    """Expose only the ASGI client for tests that do not inspect the database."""
    return api_env[0]


@pytest.fixture
async def database(api_env: tuple[AsyncClient, Database]) -> Database:
    """Expose the database bound to the same application as :func:`api_client`."""
    return api_env[1]
