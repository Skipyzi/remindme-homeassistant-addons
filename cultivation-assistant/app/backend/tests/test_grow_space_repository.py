# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
from collections.abc import AsyncGenerator
from decimal import Decimal
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from cultivation_assistant.db.engine import Database
from cultivation_assistant.grow_spaces.dimensions import CanonicalDimensions
from cultivation_assistant.grow_spaces.repository import GrowSpaceRepository
from cultivation_assistant.grow_spaces.schemas import (
    EntityMappingCreate,
    GrowSpaceCreate,
)
from pydantic import ValidationError


@pytest.fixture
async def database(tmp_path: Path) -> AsyncGenerator[Database]:
    database_path = tmp_path / "grow-spaces.db"
    config = Config("backend/alembic.ini")
    config.set_main_option("sqlalchemy.url", f"sqlite:///{database_path.as_posix()}")
    command.upgrade(config, "head")
    runtime_database = Database(f"sqlite+aiosqlite:///{database_path.as_posix()}")
    try:
        yield runtime_database
    finally:
        await runtime_database.close()


def grow_space_request(name: str = "North tent") -> GrowSpaceCreate:
    return GrowSpaceCreate.model_validate(
        {
            "name": name,
            "space_type": "tent",
            "dimensions": {
                "length": "80",
                "width": "80",
                "height": "180",
                "unit": "cm",
            },
            "mappings": [],
        }
    )


def canonical_dimensions() -> CanonicalDimensions:
    return CanonicalDimensions(
        length_m=Decimal("0.8000"),
        width_m=Decimal("0.8000"),
        height_m=Decimal("1.8000"),
    )


def test_create_schema_accepts_shared_dimension_unit() -> None:
    request = grow_space_request(" North tent ")

    assert request.name == "North tent"
    assert request.dimensions.length == Decimal("80")
    assert request.dimensions.width == Decimal("80")
    assert request.dimensions.height == Decimal("180")
    assert request.dimensions.unit == "cm"


def test_mapping_schema_rejects_invalid_entity_id() -> None:
    with pytest.raises(ValidationError):
        EntityMappingCreate(entity_id="not an entity", role="air_temperature")


def test_mapping_schema_uses_role_stale_default() -> None:
    mapping = EntityMappingCreate(
        entity_id="sensor.north_temperature",
        role="air_temperature",
    )

    assert mapping.stale_after_seconds == 300


async def test_repository_persists_and_filters_grow_spaces(database: Database) -> None:
    async with database.transaction() as session:
        repository = GrowSpaceRepository(session)
        active = await repository.add(
            grow_space_request(),
            canonical_dimensions(),
            Decimal("0.6400"),
            Decimal("1.1520"),
        )
        archived = await repository.add(
            grow_space_request("Old tent"),
            canonical_dimensions(),
            Decimal("0.6400"),
            Decimal("1.1520"),
        )
        archived.active = False

    async with database.transaction() as session:
        repository = GrowSpaceRepository(session)
        active_spaces = await repository.list(include_archived=False)
        all_spaces = await repository.list(include_archived=True)

        assert [space.id for space in active_spaces] == [active.id]
        assert {space.id for space in all_spaces} == {active.id, archived.id}
        assert await repository.active_name_exists("NORTH TENT")


async def test_repository_eager_loads_and_deletes_mappings(database: Database) -> None:
    async with database.transaction() as session:
        repository = GrowSpaceRepository(session)
        grow_space = await repository.add(
            grow_space_request(),
            canonical_dimensions(),
            Decimal("0.6400"),
            Decimal("1.1520"),
        )
        mapping = await repository.add_mapping(
            grow_space,
            EntityMappingCreate(
                entity_id="sensor.north_temperature",
                role="air_temperature",
            ),
            source_unit="°C",
            normalized_unit="°C",
        )
        mapping_id = mapping.id
        grow_space_id = grow_space.id

    async with database.transaction() as session:
        repository = GrowSpaceRepository(session)
        loaded = await repository.get(grow_space_id)
        assert loaded is not None
        assert [item.id for item in loaded.mappings] == [mapping_id]
        loaded_mapping = await repository.get_mapping(grow_space_id, mapping_id)
        assert loaded_mapping is not None
        await repository.delete_mapping(loaded_mapping)

    async with database.transaction() as session:
        repository = GrowSpaceRepository(session)
        loaded = await repository.get(grow_space_id)
        assert loaded is not None
        assert loaded.mappings == []
