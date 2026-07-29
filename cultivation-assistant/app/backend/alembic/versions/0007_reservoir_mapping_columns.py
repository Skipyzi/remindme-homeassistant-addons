# pyright: reportMissingImports=false
"""Add stale threshold and calibration metadata to reservoir entity mappings."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add stale_after_seconds and calibration to reservoir entity mappings."""
    with op.batch_alter_table("reservoir_entity_mappings") as batch_op:
        batch_op.add_column(
            sa.Column(
                "stale_after_seconds",
                sa.Integer(),
                server_default="300",
                nullable=False,
            )
        )
        batch_op.add_column(sa.Column("calibration", sa.JSON(), nullable=True))
        batch_op.create_check_constraint(
            "ck_reservoir_mapping_stale",
            "stale_after_seconds > 0",
        )


def downgrade() -> None:
    """Remove reservoir mapping staleness and calibration columns."""
    with op.batch_alter_table("reservoir_entity_mappings") as batch_op:
        batch_op.drop_constraint("ck_reservoir_mapping_stale", type_="check")
        batch_op.drop_column("calibration")
        batch_op.drop_column("stale_after_seconds")
