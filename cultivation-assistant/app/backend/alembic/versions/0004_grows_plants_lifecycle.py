# pyright: reportMissingImports=false
"""Add grows, plants, cultivars, and customizable lifecycle stages."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

DEFAULT_STAGES: tuple[tuple[str, str, str, int], ...] = (
    ("10000000-0000-4000-8000-000000000001", "seed", "Seed", 0),
    ("10000000-0000-4000-8000-000000000002", "germination", "Germination", 1),
    ("10000000-0000-4000-8000-000000000003", "seedling", "Seedling", 2),
    ("10000000-0000-4000-8000-000000000004", "vegetative", "Vegetative", 3),
    ("10000000-0000-4000-8000-000000000005", "transition", "Transition", 4),
    ("10000000-0000-4000-8000-000000000006", "flowering", "Flowering", 5),
    ("10000000-0000-4000-8000-000000000007", "finishing", "Finishing", 6),
    ("10000000-0000-4000-8000-000000000008", "harvest", "Harvest", 7),
    ("10000000-0000-4000-8000-000000000009", "drying", "Drying", 8),
    ("10000000-0000-4000-8000-00000000000a", "curing", "Curing", 9),
    ("10000000-0000-4000-8000-00000000000b", "completed", "Completed", 10),
)


def upgrade() -> None:
    """Create cultivation-record tables and seed built-in lifecycle stages."""
    timestamp_default = sa.text("CURRENT_TIMESTAMP")

    op.create_table(
        "breeders",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_breeders_lower_name", "breeders", [sa.text("lower(name)")])

    op.create_table(
        "cultivars",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("breeder_id", sa.String(length=36), nullable=True),
        sa.Column(
            "seed_type",
            sa.String(length=20),
            server_default="unknown",
            nullable=False,
        ),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.CheckConstraint(
            "seed_type IN ('regular', 'feminized', 'autoflower', 'unknown')",
            name="ck_cultivar_seed_type",
        ),
        sa.ForeignKeyConstraint(["breeder_id"], ["breeders.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_cultivars_breeder_id", "cultivars", ["breeder_id"])
    op.create_index("ix_cultivars_lower_name", "cultivars", [sa.text("lower(name)")])

    op.create_table(
        "lifecycle_stages",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("key", sa.String(length=60), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("built_in", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.CheckConstraint("position >= 0", name="ck_lifecycle_stage_position"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key", name="uq_lifecycle_stage_key"),
    )
    op.create_index("ix_lifecycle_stages_position", "lifecycle_stages", ["position"])

    op.create_table(
        "grows",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("grow_space_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default="planned",
            nullable=False,
        ),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('planned', 'active', 'completed', 'archived')",
            name="ck_grow_status",
        ),
        sa.CheckConstraint(
            "end_date IS NULL OR start_date IS NULL OR end_date >= start_date",
            name="ck_grow_dates",
        ),
        sa.ForeignKeyConstraint(
            ["grow_space_id"], ["grow_spaces.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_grows_grow_space_id", "grows", ["grow_space_id"])
    op.create_index(
        "ix_grows_space_lower_name",
        "grows",
        ["grow_space_id", sa.text("lower(name)")],
    )
    op.create_index("ix_grows_space_status", "grows", ["grow_space_id", "status"])

    op.create_table(
        "plants",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("grow_id", sa.String(length=36), nullable=False),
        sa.Column("cultivar_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("propagation_source", sa.String(length=20), nullable=False),
        sa.Column("seed_type", sa.String(length=20), nullable=True),
        sa.Column("start_date", sa.Date(), nullable=True),
        sa.Column("current_stage_id", sa.String(length=36), nullable=False),
        sa.Column(
            "status",
            sa.String(length=20),
            server_default="planned",
            nullable=False,
        ),
        sa.Column("container", sa.String(length=160), nullable=True),
        sa.Column("medium", sa.String(length=160), nullable=True),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("expected_harvest_start", sa.Date(), nullable=True),
        sa.Column("expected_harvest_end", sa.Date(), nullable=True),
        sa.Column("actual_harvest_date", sa.Date(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('planned', 'active', 'harvested', 'completed', 'lost', 'archived')",
            name="ck_plant_status",
        ),
        sa.CheckConstraint(
            "propagation_source IN ('seed', 'clone')",
            name="ck_plant_propagation_source",
        ),
        sa.CheckConstraint(
            "seed_type IS NULL OR seed_type IN "
            "('regular', 'feminized', 'autoflower', 'unknown')",
            name="ck_plant_seed_type",
        ),
        sa.CheckConstraint(
            "expected_harvest_end IS NULL OR expected_harvest_start IS NULL "
            "OR expected_harvest_end >= expected_harvest_start",
            name="ck_plant_expected_harvest",
        ),
        sa.ForeignKeyConstraint(["grow_id"], ["grows.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["cultivar_id"], ["cultivars.id"], ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(
            ["current_stage_id"], ["lifecycle_stages.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_plants_grow_id", "plants", ["grow_id"])
    op.create_index("ix_plants_cultivar_id", "plants", ["cultivar_id"])
    op.create_index("ix_plants_current_stage_id", "plants", ["current_stage_id"])
    op.create_index(
        "ix_plants_grow_lower_name",
        "plants",
        ["grow_id", sa.text("lower(name)")],
    )
    op.create_index("ix_plants_grow_status", "plants", ["grow_id", "status"])

    op.create_table(
        "plant_stage_transitions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("plant_id", sa.String(length=36), nullable=False),
        sa.Column("from_stage_id", sa.String(length=36), nullable=True),
        sa.Column("to_stage_id", sa.String(length=36), nullable=False),
        sa.Column("effective_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source", sa.String(length=40), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=timestamp_default,
            nullable=False,
        ),
        sa.CheckConstraint(
            "source IN ('user_confirmed', 'user_adjusted', 'imported', "
            "'application_recalculation')",
            name="ck_transition_source",
        ),
        sa.ForeignKeyConstraint(["plant_id"], ["plants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["from_stage_id"], ["lifecycle_stages.id"], ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["to_stage_id"], ["lifecycle_stages.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_plant_transitions_plant_id",
        "plant_stage_transitions",
        ["plant_id"],
    )
    op.create_index(
        "ix_plant_transitions_order",
        "plant_stage_transitions",
        ["plant_id", "effective_at", "created_at"],
    )

    stage_table = sa.table(
        "lifecycle_stages",
        sa.column("id", sa.String),
        sa.column("key", sa.String),
        sa.column("label", sa.String),
        sa.column("position", sa.Integer),
        sa.column("enabled", sa.Boolean),
        sa.column("built_in", sa.Boolean),
    )
    op.bulk_insert(
        stage_table,
        [
            {
                "id": stage_id,
                "key": key,
                "label": label,
                "position": position,
                "enabled": True,
                "built_in": True,
            }
            for stage_id, key, label, position in DEFAULT_STAGES
        ],
    )


def downgrade() -> None:
    """Drop cultivation-record tables in foreign-key-safe order."""
    op.drop_index("ix_plant_transitions_order", table_name="plant_stage_transitions")
    op.drop_index("ix_plant_transitions_plant_id", table_name="plant_stage_transitions")
    op.drop_table("plant_stage_transitions")
    op.drop_index("ix_plants_grow_status", table_name="plants")
    op.drop_index("ix_plants_grow_lower_name", table_name="plants")
    op.drop_index("ix_plants_current_stage_id", table_name="plants")
    op.drop_index("ix_plants_cultivar_id", table_name="plants")
    op.drop_index("ix_plants_grow_id", table_name="plants")
    op.drop_table("plants")
    op.drop_index("ix_grows_space_status", table_name="grows")
    op.drop_index("ix_grows_space_lower_name", table_name="grows")
    op.drop_index("ix_grows_grow_space_id", table_name="grows")
    op.drop_table("grows")
    op.drop_index("ix_lifecycle_stages_position", table_name="lifecycle_stages")
    op.drop_table("lifecycle_stages")
    op.drop_index("ix_cultivars_lower_name", table_name="cultivars")
    op.drop_index("ix_cultivars_breeder_id", table_name="cultivars")
    op.drop_table("cultivars")
    op.drop_index("ix_breeders_lower_name", table_name="breeders")
    op.drop_table("breeders")
