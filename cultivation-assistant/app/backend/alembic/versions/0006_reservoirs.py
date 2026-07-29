# pyright: reportMissingImports=false
"""Add reservoirs, calibration points, and entity mappings."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create reservoirs, reservoir_calibration_points, and reservoir_entity_mappings."""
    timestamp_default = sa.text("CURRENT_TIMESTAMP")

    op.create_table(
        "reservoirs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("reservoir_type", sa.String(length=40), nullable=False),
        sa.Column("primary_grow_space_id", sa.String(length=36), nullable=True),
        sa.Column("capacity_liters", sa.Numeric(12, 4), nullable=False),
        sa.Column("usable_capacity_liters", sa.Numeric(12, 4), nullable=True),
        sa.Column("minimum_safe_volume_liters", sa.Numeric(12, 4), nullable=True),
        sa.Column("refill_threshold_liters", sa.Numeric(12, 4), nullable=True),
        sa.Column("overflow_threshold_liters", sa.Numeric(12, 4), nullable=True),
        sa.Column("geometry_shape", sa.String(length=40), nullable=False),
        sa.Column("geometry_unit", sa.String(length=8), nullable=True),
        sa.Column("geometry_length_m", sa.Numeric(12, 4), nullable=True),
        sa.Column("geometry_width_m", sa.Numeric(12, 4), nullable=True),
        sa.Column("geometry_height_m", sa.Numeric(12, 4), nullable=True),
        sa.Column("geometry_diameter_m", sa.Numeric(12, 4), nullable=True),
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
            "reservoir_type IN ('autopot_reservoir', 'dwc_bucket', 'rdwc_control_reservoir', "
            "'irrigation_supply_tank', 'mixing_tank', 'top_off_tank', 'ro_source_water_tank', "
            "'runoff_waste_tank', 'custom_reservoir')",
            name="ck_reservoir_type",
        ),
        sa.CheckConstraint(
            "geometry_shape IN ('rectangular', 'vertical_cylinder', 'horizontal_cylinder', "
            "'custom_calibration_table')",
            name="ck_reservoir_geometry_shape",
        ),
        sa.CheckConstraint("capacity_liters > 0", name="ck_reservoir_capacity"),
        sa.CheckConstraint(
            "usable_capacity_liters IS NULL OR usable_capacity_liters <= capacity_liters",
            name="ck_reservoir_usable_capacity",
        ),
        sa.ForeignKeyConstraint(
            ["primary_grow_space_id"], ["grow_spaces.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_reservoirs_active_name", "reservoirs", ["active", "name"])
    op.create_index(
        "ix_reservoirs_primary_grow_space_id", "reservoirs", ["primary_grow_space_id"]
    )

    op.create_table(
        "reservoir_calibration_points",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("reservoir_id", sa.String(length=36), nullable=False),
        sa.Column("raw_value", sa.Numeric(12, 4), nullable=False),
        sa.Column("volume_liters", sa.Numeric(12, 4), nullable=False),
        sa.ForeignKeyConstraint(["reservoir_id"], ["reservoirs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "reservoir_id", "raw_value", name="uq_reservoir_calibration_raw_value"
        ),
    )
    op.create_index(
        "ix_reservoir_calibration_points_reservoir_id",
        "reservoir_calibration_points",
        ["reservoir_id"],
    )

    op.create_table(
        "reservoir_entity_mappings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("reservoir_id", sa.String(length=36), nullable=False),
        sa.Column("entity_id", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=40), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=True),
        sa.Column("priority", sa.Integer(), server_default="100", nullable=False),
        sa.Column("source_unit", sa.String(length=40), nullable=True),
        sa.Column("normalized_unit", sa.String(length=40), nullable=True),
        sa.Column("enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
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
        sa.CheckConstraint("priority >= 0", name="ck_reservoir_mapping_priority"),
        sa.ForeignKeyConstraint(["reservoir_id"], ["reservoirs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "reservoir_id", "entity_id", "role", name="uq_reservoir_mapping_role"
        ),
    )
    op.create_index(
        "ix_reservoir_mappings_role_priority",
        "reservoir_entity_mappings",
        ["reservoir_id", "role", "priority"],
    )


def downgrade() -> None:
    """Drop reservoir tables in foreign-key-safe order."""
    op.drop_index(
        "ix_reservoir_mappings_role_priority", table_name="reservoir_entity_mappings"
    )
    op.drop_table("reservoir_entity_mappings")
    op.drop_index(
        "ix_reservoir_calibration_points_reservoir_id",
        table_name="reservoir_calibration_points",
    )
    op.drop_table("reservoir_calibration_points")
    op.drop_index("ix_reservoirs_primary_grow_space_id", table_name="reservoirs")
    op.drop_index("ix_reservoirs_active_name", table_name="reservoirs")
    op.drop_table("reservoirs")
