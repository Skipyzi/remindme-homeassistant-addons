# pyright: reportMissingImports=false
from decimal import Decimal
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, Table, create_engine, inspect, select
from sqlalchemy.orm import Session


def _config(database_path: Path) -> Config:
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    return config


def test_dimension_migration_preserves_legacy_measurements(tmp_path: Path) -> None:
    database_path = tmp_path / "dimensions.db"
    config = _config(database_path)
    command.upgrade(config, "0002")
    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        grow_spaces = Table("grow_spaces", MetaData(), autoload_with=engine)
        with Session(engine) as session:
            session.execute(
                grow_spaces.insert().values(
                    id="legacy-space",
                    name="Legacy cabinet",
                    space_type="cabinet",
                    active=True,
                    area_m2=1.2,
                    volume_m3=2.4,
                )
            )
            session.commit()

        command.upgrade(config, "0003")
        inspector = inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("grow_spaces")}
        metadata = MetaData()
        migrated_spaces = Table("grow_spaces", metadata, autoload_with=engine)
        alembic_version = Table("alembic_version", metadata, autoload_with=engine)
        with Session(engine) as session:
            revision = session.scalar(select(alembic_version.c.version_num))
            preserved = (
                session.execute(
                    select(
                        migrated_spaces.c.space_type,
                        migrated_spaces.c.area_m2,
                        migrated_spaces.c.volume_m3,
                        migrated_spaces.c.length_m,
                        migrated_spaces.c.width_m,
                        migrated_spaces.c.height_m,
                        migrated_spaces.c.dimension_unit,
                    ).where(migrated_spaces.c.id == "legacy-space")
                )
                .mappings()
                .one()
            )

        assert revision == "0003"
        assert columns >= {"length_m", "width_m", "height_m", "dimension_unit"}
        assert preserved["space_type"] == "cabinet"
        assert preserved["area_m2"] == Decimal("1.2000")
        assert preserved["volume_m3"] == Decimal("2.4000")
        assert preserved["length_m"] is None
        assert preserved["width_m"] is None
        assert preserved["height_m"] is None
        assert preserved["dimension_unit"] is None
    finally:
        engine.dispose()


def test_dimension_migration_downgrades_to_0002(tmp_path: Path) -> None:
    database_path = tmp_path / "downgrade.db"
    config = _config(database_path)
    command.upgrade(config, "head")
    command.downgrade(config, "0002")

    engine = create_engine(f"sqlite:///{database_path.as_posix()}")
    try:
        inspector = inspect(engine)
        columns = {column["name"] for column in inspector.get_columns("grow_spaces")}
        alembic_version = Table("alembic_version", MetaData(), autoload_with=engine)
        with Session(engine) as session:
            revision = session.scalar(select(alembic_version.c.version_num))

        assert revision == "0002"
        assert not {"length_m", "width_m", "height_m", "dimension_unit"} & columns
    finally:
        engine.dispose()
