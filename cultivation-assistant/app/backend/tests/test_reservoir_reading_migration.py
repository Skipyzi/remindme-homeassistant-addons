# pyright: reportMissingImports=false
import sqlite3
from collections.abc import Iterator
from pathlib import Path

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
    yield _config(tmp_path / "reservoir-reading-migration.db")


def test_0008_creates_reservoir_readings_table(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0007")
    url = alembic_config.get_main_option("sqlalchemy.url")
    assert url is not None
    database_path = url.removeprefix("sqlite:///")

    connection = sqlite3.connect(database_path)
    try:
        before = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    finally:
        connection.close()
    assert "reservoir_readings" not in before

    command.upgrade(alembic_config, "0008")

    connection = sqlite3.connect(database_path)
    try:
        after = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        columns = {row[1] for row in connection.execute("PRAGMA table_info(reservoir_readings)")}
        indexes = {
            row[1]
            for row in connection.execute("PRAGMA index_list(reservoir_readings)")
        }
    finally:
        connection.close()
    assert "reservoir_readings" in after
    assert {
        "id",
        "reservoir_id",
        "recorded_at",
        "source_entity_id",
        "role",
        "volume_liters",
        "level_percent",
    } <= columns
    assert "ix_reservoir_readings_reservoir_recorded" in indexes


def test_0008_downgrade_returns_to_0007(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0008")
    command.downgrade(alembic_config, "0007")
    assert current_revision(alembic_config) == "0007"

    url = alembic_config.get_main_option("sqlalchemy.url")
    assert url is not None
    database_path = url.removeprefix("sqlite:///")
    connection = sqlite3.connect(database_path)
    try:
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    finally:
        connection.close()
    assert "reservoir_readings" not in tables
