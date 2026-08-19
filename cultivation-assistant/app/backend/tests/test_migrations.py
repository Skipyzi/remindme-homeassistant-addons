from pathlib import Path

from alembic import command
from alembic.config import Config
from cultivation_assistant.db.engine import Database
from sqlalchemy import create_engine, inspect


def test_initial_migration_creates_foundation_tables(tmp_path: Path) -> None:
    database_path = tmp_path / "migration.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")

    command.upgrade(config, "head")

    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        inspector = inspect(engine)
        assert {
            "alembic_version",
            "app_settings",
            "integration_status",
            "audit_log",
        } <= set(inspector.get_table_names())
        assert inspector.get_pk_constraint("audit_log")["constrained_columns"] == ["id"]
    finally:
        engine.dispose()


async def test_database_reports_current_schema_version(tmp_path: Path) -> None:
    database_path = tmp_path / "schema-version.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")
    database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")

    version = await database.schema_version()
    await database.close()

    assert version == "0008"
