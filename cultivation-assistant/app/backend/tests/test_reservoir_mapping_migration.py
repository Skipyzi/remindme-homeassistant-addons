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
    yield _config(tmp_path / "reservoir-mapping-migration.db")


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def test_0007_adds_mapping_columns(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0006")
    url = alembic_config.get_main_option("sqlalchemy.url")
    assert url is not None
    database_path = url.removeprefix("sqlite:///")

    connection = sqlite3.connect(database_path)
    try:
        before = _columns(connection, "reservoir_entity_mappings")
    finally:
        connection.close()
    assert "stale_after_seconds" not in before
    assert "calibration" not in before

    command.upgrade(alembic_config, "0007")

    connection = sqlite3.connect(database_path)
    try:
        after = _columns(connection, "reservoir_entity_mappings")
    finally:
        connection.close()
    assert {"stale_after_seconds", "calibration"} <= after


def test_0007_backfills_existing_mappings_with_default(alembic_config: Config) -> None:
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
            "INSERT INTO reservoir_entity_mappings (id, reservoir_id, entity_id, role) "
            "VALUES ('map-1', 'res-1', 'sensor.tank_level', 'level_percentage')"
        )
        connection.commit()
    finally:
        connection.close()

    command.upgrade(alembic_config, "0007")

    connection = sqlite3.connect(database_path)
    try:
        row = connection.execute(
            "SELECT stale_after_seconds, calibration FROM reservoir_entity_mappings "
            "WHERE id = 'map-1'"
        ).fetchone()
    finally:
        connection.close()
    assert row[0] == 300
    assert row[1] is None


def test_0007_downgrade_returns_to_0006(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0007")
    command.downgrade(alembic_config, "0006")
    assert current_revision(alembic_config) == "0006"
