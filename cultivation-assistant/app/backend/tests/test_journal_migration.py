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
    yield _config(tmp_path / "journal-migration.db")


@pytest.fixture
async def migrated_database(tmp_path: Path) -> AsyncGenerator[Path]:
    database_path = tmp_path / "journal.db"
    command.upgrade(_config(database_path), "0005")
    yield database_path


async def test_0005_creates_journal_tables(migrated_database: Path) -> None:
    async with aiosqlite.connect(migrated_database) as connection:
        tables = {
            row[0]
            for row in await connection.execute_fetchall(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
    assert {"journal_entries", "measurements", "photos"} <= tables


def test_0005_downgrade_returns_to_0004(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0005")
    command.downgrade(alembic_config, "0004")
    assert current_revision(alembic_config) == "0004"


def test_0005_downgrade_with_records_returns_to_0004(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0005")
    url = alembic_config.get_main_option("sqlalchemy.url")
    assert url is not None
    database_path = url.removeprefix("sqlite:///")
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(
            "INSERT INTO grow_spaces (id, name, space_type, active) VALUES "
            "('space-1', 'North tent', 'tent', 1)"
        )
        connection.execute(
            "INSERT INTO cultivars (id, name, seed_type, active) VALUES "
            "('cultivar-1', 'Mystery Cut', 'unknown', 1)"
        )
        connection.execute(
            "INSERT INTO grows (id, grow_space_id, name, status) VALUES "
            "('grow-1', 'space-1', 'Summer run', 'planned')"
        )
        seedling_id = connection.execute(
            "SELECT id FROM lifecycle_stages WHERE key='seedling'"
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO plants (id, grow_id, cultivar_id, name, propagation_source, "
            "current_stage_id, status) VALUES "
            "('plant-1', 'grow-1', 'cultivar-1', 'North 1', 'seed', ?, 'planned')",
            (seedling_id,),
        )
        connection.execute(
            "INSERT INTO journal_entries (id, subject_type, subject_id, entry_type, "
            "occurred_at, tags) VALUES "
            "('entry-1', 'plant', 'plant-1', 'note', '2026-07-25T10:00:00+00:00', '[]')"
        )
        connection.execute(
            "INSERT INTO measurements (id, plant_id, metric_type, value, unit, "
            "occurred_at) VALUES "
            "('measurement-1', 'plant-1', 'height', 32.5, 'cm', '2026-07-25T10:00:00+00:00')"
        )
        connection.execute(
            "INSERT INTO photos (id, plant_id, journal_entry_id, measurement_id, "
            "tags, file_path, content_type, file_size, occurred_at) VALUES "
            "('photo-1', 'plant-1', 'entry-1', 'measurement-1', '[]', "
            "'plant-1/photo-1.png', 'image/png', 10, '2026-07-25T10:00:00+00:00')"
        )
        connection.commit()
    finally:
        connection.close()

    command.downgrade(alembic_config, "0004")
    assert current_revision(alembic_config) == "0004"
