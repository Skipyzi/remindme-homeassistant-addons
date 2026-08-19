# pyright: reportMissingImports=false
"""Add reservoir level readings for consumption and refill forecasts."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create reservoir_readings as the level time-series per reservoir."""
    op.create_table(
        "reservoir_readings",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("reservoir_id", sa.String(length=36), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_entity_id", sa.String(length=255), nullable=False),
        sa.Column("role", sa.String(length=40), nullable=False),
        sa.Column("volume_liters", sa.Numeric(12, 4), nullable=False),
        sa.Column("level_percent", sa.Numeric(7, 4), nullable=True),
        sa.CheckConstraint("volume_liters >= 0", name="ck_reservoir_reading_volume"),
        sa.ForeignKeyConstraint(["reservoir_id"], ["reservoirs.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_reservoir_readings_reservoir_recorded",
        "reservoir_readings",
        ["reservoir_id", "recorded_at"],
    )


def downgrade() -> None:
    """Drop the reservoir readings time-series."""
    op.drop_index(
        "ix_reservoir_readings_reservoir_recorded", table_name="reservoir_readings"
    )
    op.drop_table("reservoir_readings")
