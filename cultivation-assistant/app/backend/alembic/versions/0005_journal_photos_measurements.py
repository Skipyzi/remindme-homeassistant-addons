# pyright: reportMissingImports=false
"""Add journal entries, measurements, and photos."""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create journal_entries, measurements, and photos tables."""
    timestamp_default = sa.text("CURRENT_TIMESTAMP")

    op.create_table(
        "journal_entries",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("subject_type", sa.String(length=20), nullable=False),
        sa.Column("subject_id", sa.String(length=36), nullable=False),
        sa.Column("entry_type", sa.String(length=40), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("tags", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("related_stage_id", sa.String(length=36), nullable=True),
        sa.Column("related_issue", sa.Text(), nullable=True),
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
        sa.CheckConstraint("subject_type IN ('plant', 'grow')", name="ck_journal_subject_type"),
        sa.CheckConstraint(
            "entry_type IN ('watered', 'fed', 'transplanted', 'topped', 'trained', "
            "'defoliated', 'light_schedule_changed', 'flowering_initiated', "
            "'first_flowers_observed', 'problem_observed', 'treatment_applied', "
            "'harvested', 'drying_started', 'jarred', 'cure_milestone', 'note')",
            name="ck_journal_entry_type",
        ),
        sa.ForeignKeyConstraint(
            ["related_stage_id"], ["lifecycle_stages.id"], ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_journal_entries_subject",
        "journal_entries",
        ["subject_type", "subject_id", "occurred_at"],
    )

    op.create_table(
        "measurements",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("plant_id", sa.String(length=36), nullable=False),
        sa.Column("metric_type", sa.String(length=40), nullable=False),
        sa.Column("custom_metric_name", sa.String(length=120), nullable=True),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("unit", sa.String(length=40), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
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
            "metric_type IN ('height', 'width', 'canopy_diameter', 'stem_diameter', "
            "'node_count', 'container_weight', 'plant_weight', 'custom')",
            name="ck_measurement_metric_type",
        ),
        sa.ForeignKeyConstraint(["plant_id"], ["plants.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_measurements_plant_order", "measurements", ["plant_id", "occurred_at"])

    op.create_table(
        "photos",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("plant_id", sa.String(length=36), nullable=False),
        sa.Column("journal_entry_id", sa.String(length=36), nullable=True),
        sa.Column("measurement_id", sa.String(length=36), nullable=True),
        sa.Column("stage_id", sa.String(length=36), nullable=True),
        sa.Column("caption", sa.String(length=200), nullable=True),
        sa.Column("tags", sa.JSON(), server_default="[]", nullable=False),
        sa.Column("file_path", sa.String(length=400), nullable=False),
        sa.Column("content_type", sa.String(length=40), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
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
            "content_type IN ('image/jpeg', 'image/png', 'image/webp')",
            name="ck_photo_content_type",
        ),
        sa.ForeignKeyConstraint(["plant_id"], ["plants.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["journal_entry_id"], ["journal_entries.id"], ondelete="SET NULL"
        ),
        sa.ForeignKeyConstraint(["measurement_id"], ["measurements.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["stage_id"], ["lifecycle_stages.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_photos_plant_order", "photos", ["plant_id", "occurred_at"])
    op.create_index("ix_photos_journal_entry_id", "photos", ["journal_entry_id"])
    op.create_index("ix_photos_measurement_id", "photos", ["measurement_id"])


def downgrade() -> None:
    """Drop journal tables in foreign-key-safe order."""
    op.drop_index("ix_photos_measurement_id", table_name="photos")
    op.drop_index("ix_photos_journal_entry_id", table_name="photos")
    op.drop_index("ix_photos_plant_order", table_name="photos")
    op.drop_table("photos")
    op.drop_index("ix_measurements_plant_order", table_name="measurements")
    op.drop_table("measurements")
    op.drop_index("ix_journal_entries_subject", table_name="journal_entries")
    op.drop_table("journal_entries")
