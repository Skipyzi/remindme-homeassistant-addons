# pyright: reportMissingImports=false
import sqlite3
from collections.abc import AsyncGenerator, Iterator
from pathlib import Path

import aiosqlite
import pytest
from alembic import command
from alembic.config import Config


def _config(database_path: Path) -> Config:
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    return config


def current_revision(config: Config) -> str:
    from alembic.runtime.migration import MigrationContext
    from sqlalchemy import create_engine

    url = config.get_main_option("sqlalchemy.url")
    assert url is not None
    engine = create_engine(url)
    try:
        with engine.connect() as connection:
            revision = MigrationContext.configure(connection).get_current_revision()
    finally:
        engine.dispose()
    return revision or "base"


@pytest.fixture
def alembic_config(tmp_path: Path) -> Iterator[Config]:
    yield _config(tmp_path / "reservoir-migration.db")


@pytest.fixture
async def migrated_database(tmp_path: Path) -> AsyncGenerator[Path]:
    database_path = tmp_path / "reservoir.db"
    command.upgrade(_config(database_path), "0006")
    yield database_path


async def test_0006_creates_reservoir_tables(migrated_database: Path) -> None:
    async with aiosqlite.connect(migrated_database) as connection:
        tables = {
            row[0]
            for row in await connection.execute_fetchall(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert {"reservoirs", "reservoir_calibration_points", "reservoir_entity_mappings"} <= tables


def test_0006_downgrade_returns_to_0005(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0006")
    command.downgrade(alembic_config, "0005")
    assert current_revision(alembic_config) == "0005"


def test_0006_downgrade_with_records_returns_to_0005(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0006")
    url = alembic_config.get_main_option("sqlalchemy.url")
    assert url is not None
    database_path = url.removeprefix("sqlite:///")
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO reservoirs (id, name, reservoir_type, capacity_liters, "
            "geometry_shape, active) VALUES "
            "('res-1', 'Mixing tank', 'mixing_tank', 100, 'rectangular', 1)"
        )
        connection.execute(
            "INSERT INTO reservoir_calibration_points (id, reservoir_id, raw_value, "
            "volume_liters) VALUES ('cal-1', 'res-1', 0, 0)"
        )
        connection.execute(
            "INSERT INTO reservoir_entity_mappings (id, reservoir_id, entity_id, role) "
            "VALUES ('map-1', 'res-1', 'sensor.tank_level', 'level_percentage')"
        )
        connection.commit()
    finally:
        connection.close()

    command.downgrade(alembic_config, "0005")
    assert current_revision(alembic_config) == "0005"
