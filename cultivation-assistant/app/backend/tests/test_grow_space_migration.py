# pyright: reportMissingImports=false
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


def test_grow_space_migration_creates_constraints(tmp_path: Path) -> None:
    database_path = tmp_path / "cultivation.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")

    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        inspector = inspect(engine)
        constraints = inspector.get_unique_constraints("entity_mappings")
        checks = inspector.get_check_constraints("entity_mappings")

        assert {"grow_spaces", "entity_mappings"} <= set(inspector.get_table_names())
        assert any(
            constraint["column_names"] == ["grow_space_id", "entity_id", "role"]
            for constraint in constraints
        )
        assert {check["name"] for check in checks} >= {
            "ck_mapping_priority",
            "ck_mapping_stale",
        }
    finally:
        engine.dispose()
