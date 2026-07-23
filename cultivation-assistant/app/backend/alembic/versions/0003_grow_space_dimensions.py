# pyright: reportMissingImports=false
"""Add editable canonical dimensions to grow spaces."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add nullable dimension fields without inventing legacy geometry."""
    with op.batch_alter_table("grow_spaces") as batch_op:
        batch_op.add_column(sa.Column("length_m", sa.Numeric(12, 4), nullable=True))
        batch_op.add_column(sa.Column("width_m", sa.Numeric(12, 4), nullable=True))
        batch_op.add_column(sa.Column("height_m", sa.Numeric(12, 4), nullable=True))
        batch_op.add_column(sa.Column("dimension_unit", sa.String(8), nullable=True))
        batch_op.create_check_constraint(
            "ck_grow_space_length",
            "length_m IS NULL OR length_m > 0",
        )
        batch_op.create_check_constraint(
            "ck_grow_space_width",
            "width_m IS NULL OR width_m > 0",
        )
        batch_op.create_check_constraint(
            "ck_grow_space_height",
            "height_m IS NULL OR height_m > 0",
        )
        batch_op.create_check_constraint(
            "ck_grow_space_dimension_unit",
            "dimension_unit IS NULL OR dimension_unit IN ('cm', 'in')",
        )


def downgrade() -> None:
    """Remove editable dimensions while retaining derived measurements."""
    with op.batch_alter_table("grow_spaces") as batch_op:
        batch_op.drop_constraint("ck_grow_space_dimension_unit", type_="check")
        batch_op.drop_constraint("ck_grow_space_height", type_="check")
        batch_op.drop_constraint("ck_grow_space_width", type_="check")
        batch_op.drop_constraint("ck_grow_space_length", type_="check")
        batch_op.drop_column("dimension_unit")
        batch_op.drop_column("height_m")
        batch_op.drop_column("width_m")
        batch_op.drop_column("length_m")
