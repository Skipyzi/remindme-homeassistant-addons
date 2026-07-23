# pyright: reportMissingImports=false
"""Add universal grow spaces and semantic entity mappings."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create grow-space configuration and mapping tables."""
    timestamp_default = sa.text("CURRENT_TIMESTAMP")
    op.create_table(
        "grow_spaces",
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("location", sa.String(length=200), nullable=True),
        sa.Column("space_type", sa.String(length=40), nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("area_m2", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("volume_m3", sa.Numeric(precision=12, scale=4), nullable=True),
        sa.Column("id", sa.String(length=36), nullable=False),
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
        sa.CheckConstraint("area_m2 IS NULL OR area_m2 > 0", name="ck_grow_space_area"),
        sa.CheckConstraint("volume_m3 IS NULL OR volume_m3 > 0", name="ck_grow_space_volume"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_grow_spaces_active_name",
        "grow_spaces",
        ["active", "name"],
    )

    op.create_table(
        "entity_mappings",
        sa.Column("grow_space_id", sa.String(length=36), nullable=False),
        sa.Column("entity_id", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=80), nullable=False),
        sa.Column("display_name", sa.String(length=160), nullable=True),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column("source_unit", sa.String(length=40), nullable=True),
        sa.Column("normalized_unit", sa.String(length=40), nullable=True),
        sa.Column("enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("calibration", sa.JSON(), nullable=True),
        sa.Column("stale_after_seconds", sa.Integer(), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
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
        sa.CheckConstraint("priority >= 0", name="ck_mapping_priority"),
        sa.CheckConstraint("stale_after_seconds > 0", name="ck_mapping_stale"),
        sa.ForeignKeyConstraint(
            ["grow_space_id"],
            ["grow_spaces.id"],
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "grow_space_id",
            "entity_id",
            "role",
            name="uq_mapping_role",
        ),
    )
    op.create_index(
        "ix_entity_mappings_grow_space_id",
        "entity_mappings",
        ["grow_space_id"],
    )
    op.create_index(
        "ix_entity_mappings_role_priority",
        "entity_mappings",
        ["grow_space_id", "role", "priority"],
    )


def downgrade() -> None:
    """Remove entity mappings before their grow-space parents."""
    op.drop_index("ix_entity_mappings_role_priority", table_name="entity_mappings")
    op.drop_index("ix_entity_mappings_grow_space_id", table_name="entity_mappings")
    op.drop_table("entity_mappings")
    op.drop_index("ix_grow_spaces_active_name", table_name="grow_spaces")
    op.drop_table("grow_spaces")
