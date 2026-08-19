# pyright: reportMissingImports=false
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
    yield _config(tmp_path / "grows-plants-migration.db")


@pytest.fixture
async def migrated_database(tmp_path: Path) -> AsyncGenerator[Path]:
    database_path = tmp_path / "grows-plants.db"
    command.upgrade(_config(database_path), "0004")
    yield database_path


async def test_0004_creates_tables_and_seeded_stages(migrated_database: Path) -> None:
    async with aiosqlite.connect(migrated_database) as connection:
        tables = {
            row[0]
            for row in await connection.execute_fetchall(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        stages = await connection.execute_fetchall(
            "SELECT key, label, position, enabled, built_in FROM lifecycle_stages ORDER BY position"
        )
    assert {
        "breeders",
        "cultivars",
        "lifecycle_stages",
        "grows",
        "plants",
        "plant_stage_transitions",
    } <= tables
    assert [row[0] for row in stages] == [
        "seed",
        "germination",
        "seedling",
        "vegetative",
        "transition",
        "flowering",
        "finishing",
        "harvest",
        "drying",
        "curing",
        "completed",
    ]
    assert all(row[2] == index for index, row in enumerate(stages))
    assert all(row[3] == 1 and row[4] == 1 for row in stages)


def test_0004_downgrade_returns_to_0003(alembic_config: Config) -> None:
    command.upgrade(alembic_config, "0004")
    command.downgrade(alembic_config, "0003")
    assert current_revision(alembic_config) == "0003"


def test_0004_downgrade_with_records_returns_to_0003(alembic_config: Config) -> None:
    import sqlite3

    command.upgrade(alembic_config, "0004")
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
            "INSERT INTO plant_stage_transitions (id, plant_id, from_stage_id, to_stage_id, "
            "effective_at, source) VALUES "
            "('t-1', 'plant-1', NULL, ?, '2026-07-23T10:00:00+00:00', 'user_confirmed')",
            (seedling_id,),
        )
        connection.commit()
    finally:
        connection.close()

    command.downgrade(alembic_config, "0003")
    assert current_revision(alembic_config) == "0003"
