# pyright: reportMissingImports=false
"""Foundation SQLAlchemy models."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any
from uuid import uuid4

import sqlalchemy as sa
from sqlalchemy import orm


class Base(orm.DeclarativeBase):
    """Declarative model base."""


class UUIDPrimaryKeyMixin:
    """Use stable UUID strings for SQLite-compatible primary keys."""

    id: orm.Mapped[str] = orm.mapped_column(
        sa.String(36), primary_key=True, default=lambda: str(uuid4())
    )


class TimestampMixin:
    """Store creation and modification timestamps as UTC-aware values."""

    created_at: orm.Mapped[datetime] = orm.mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.current_timestamp(),
        nullable=False,
    )
    updated_at: orm.Mapped[datetime] = orm.mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.current_timestamp(),
        onupdate=sa.func.current_timestamp(),
        nullable=False,
    )


class AppSetting(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One validated application setting."""

    __tablename__ = "app_settings"

    key: orm.Mapped[str] = orm.mapped_column(sa.String(120), unique=True, nullable=False)
    value: orm.Mapped[dict[str, Any]] = orm.mapped_column(sa.JSON, nullable=False)


class IntegrationStatus(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Last known state of an internal or Home Assistant integration."""

    __tablename__ = "integration_status"

    component: orm.Mapped[str] = orm.mapped_column(sa.String(120), unique=True, nullable=False)
    status: orm.Mapped[str] = orm.mapped_column(sa.String(40), nullable=False)
    details: orm.Mapped[dict[str, Any]] = orm.mapped_column(sa.JSON, default=dict, nullable=False)
    version: orm.Mapped[int] = orm.mapped_column(sa.Integer, default=1, nullable=False)


class AuditLog(UUIDPrimaryKeyMixin, Base):
    """Append-only record of consequential application changes and requests."""

    __tablename__ = "audit_log"

    occurred_at: orm.Mapped[datetime] = orm.mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.current_timestamp(),
        nullable=False,
    )
    actor: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    action: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    resource_type: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    resource_id: orm.Mapped[str | None] = orm.mapped_column(sa.String(36))
    correlation_id: orm.Mapped[str | None] = orm.mapped_column(sa.String(120))
    details: orm.Mapped[dict[str, Any]] = orm.mapped_column(sa.JSON, default=dict, nullable=False)
    message: orm.Mapped[str | None] = orm.mapped_column(sa.Text)


class GrowSpace(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Universal physical cultivation area with attachable capabilities."""

    __tablename__ = "grow_spaces"
    __table_args__ = (
        sa.Index("ix_grow_spaces_active_name", "active", "name"),
        sa.CheckConstraint("area_m2 IS NULL OR area_m2 > 0", name="ck_grow_space_area"),
        sa.CheckConstraint("volume_m3 IS NULL OR volume_m3 > 0", name="ck_grow_space_volume"),
        sa.CheckConstraint("length_m IS NULL OR length_m > 0", name="ck_grow_space_length"),
        sa.CheckConstraint("width_m IS NULL OR width_m > 0", name="ck_grow_space_width"),
        sa.CheckConstraint("height_m IS NULL OR height_m > 0", name="ck_grow_space_height"),
        sa.CheckConstraint(
            "dimension_unit IS NULL OR dimension_unit IN ('cm', 'in')",
            name="ck_grow_space_dimension_unit",
        ),
    )

    name: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    description: orm.Mapped[str | None] = orm.mapped_column(sa.Text)
    location: orm.Mapped[str | None] = orm.mapped_column(sa.String(200))
    space_type: orm.Mapped[str] = orm.mapped_column(sa.String(40), nullable=False)
    active: orm.Mapped[bool] = orm.mapped_column(
        sa.Boolean, default=True, server_default=sa.true(), nullable=False
    )
    area_m2: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
    volume_m3: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
    length_m: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
    width_m: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
    height_m: orm.Mapped[Decimal | None] = orm.mapped_column(sa.Numeric(12, 4))
    dimension_unit: orm.Mapped[str | None] = orm.mapped_column(sa.String(8))
    mappings: orm.Mapped[list[EntityMapping]] = orm.relationship(
        back_populates="grow_space",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class EntityMapping(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Map one Home Assistant entity to one grow-space semantic role."""

    __tablename__ = "entity_mappings"
    __table_args__ = (
        sa.UniqueConstraint(
            "grow_space_id",
            "entity_id",
            "role",
            name="uq_mapping_role",
        ),
        sa.CheckConstraint("priority >= 0", name="ck_mapping_priority"),
        sa.CheckConstraint("stale_after_seconds > 0", name="ck_mapping_stale"),
        sa.Index("ix_entity_mappings_role_priority", "grow_space_id", "role", "priority"),
    )

    grow_space_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("grow_spaces.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    entity_id: orm.Mapped[str] = orm.mapped_column(sa.String(255), nullable=False)
    role: orm.Mapped[str] = orm.mapped_column(sa.String(80), nullable=False)
    display_name: orm.Mapped[str | None] = orm.mapped_column(sa.String(160))
    priority: orm.Mapped[int] = orm.mapped_column(default=100, nullable=False)
    source_unit: orm.Mapped[str | None] = orm.mapped_column(sa.String(40))
    normalized_unit: orm.Mapped[str | None] = orm.mapped_column(sa.String(40))
    enabled: orm.Mapped[bool] = orm.mapped_column(
        sa.Boolean, default=True, server_default=sa.true(), nullable=False
    )
    calibration: orm.Mapped[dict[str, Any] | None] = orm.mapped_column(sa.JSON)
    stale_after_seconds: orm.Mapped[int] = orm.mapped_column(nullable=False)
    grow_space: orm.Mapped[GrowSpace] = orm.relationship(back_populates="mappings")


class Breeder(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Minimal breeder identity referenced by cultivars."""

    __tablename__ = "breeders"
    __table_args__ = (sa.Index("ix_breeders_lower_name", sa.func.lower("name")),)

    name: orm.Mapped[str] = orm.mapped_column(sa.String(160), nullable=False)
    active: orm.Mapped[bool] = orm.mapped_column(
        sa.Boolean, default=True, server_default=sa.true(), nullable=False
    )


class Cultivar(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Minimal structured cultivar identity with an optional breeder."""

    __tablename__ = "cultivars"
    __table_args__ = (
        sa.CheckConstraint(
            "seed_type IN ('regular', 'feminized', 'autoflower', 'unknown')",
            name="ck_cultivar_seed_type",
        ),
        sa.Index("ix_cultivars_lower_name", sa.func.lower("name")),
    )

    name: orm.Mapped[str] = orm.mapped_column(sa.String(160), nullable=False)
    breeder_id: orm.Mapped[str | None] = orm.mapped_column(
        sa.ForeignKey("breeders.id", ondelete="RESTRICT"),
        nullable=True,
        index=True,
    )
    seed_type: orm.Mapped[str] = orm.mapped_column(
        sa.String(20), default="unknown", server_default="unknown", nullable=False
    )
    active: orm.Mapped[bool] = orm.mapped_column(
        sa.Boolean, default=True, server_default=sa.true(), nullable=False
    )
    breeder: orm.Mapped[Breeder | None] = orm.relationship(lazy="joined")


class LifecycleStage(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Installation-wide lifecycle stage definition."""

    __tablename__ = "lifecycle_stages"
    __table_args__ = (
        sa.UniqueConstraint("key", name="uq_lifecycle_stage_key"),
        sa.CheckConstraint("position >= 0", name="ck_lifecycle_stage_position"),
        sa.Index("ix_lifecycle_stages_position", "position"),
    )

    key: orm.Mapped[str] = orm.mapped_column(sa.String(60), nullable=False)
    label: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    position: orm.Mapped[int] = orm.mapped_column(sa.Integer, nullable=False)
    enabled: orm.Mapped[bool] = orm.mapped_column(
        sa.Boolean, default=True, server_default=sa.true(), nullable=False
    )
    built_in: orm.Mapped[bool] = orm.mapped_column(
        sa.Boolean, default=False, server_default=sa.false(), nullable=False
    )


class Grow(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """First-class cultivation cycle within one Grow Space."""

    __tablename__ = "grows"
    __table_args__ = (
        sa.CheckConstraint(
            "status IN ('planned', 'active', 'completed', 'archived')",
            name="ck_grow_status",
        ),
        sa.CheckConstraint(
            "end_date IS NULL OR start_date IS NULL OR end_date >= start_date",
            name="ck_grow_dates",
        ),
        sa.Index("ix_grows_space_lower_name", "grow_space_id", sa.func.lower("name")),
        sa.Index("ix_grows_space_status", "grow_space_id", "status"),
    )

    grow_space_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("grow_spaces.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    name: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    status: orm.Mapped[str] = orm.mapped_column(
        sa.String(20), default="planned", server_default="planned", nullable=False
    )
    start_date: orm.Mapped[date | None] = orm.mapped_column(sa.Date)
    end_date: orm.Mapped[date | None] = orm.mapped_column(sa.Date)
    notes: orm.Mapped[str | None] = orm.mapped_column(sa.Text)


class Plant(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Individually identifiable Plant with a projected current stage."""

    __tablename__ = "plants"
    __table_args__ = (
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
        sa.Index("ix_plants_grow_lower_name", "grow_id", sa.func.lower("name")),
        sa.Index("ix_plants_grow_status", "grow_id", "status"),
    )

    grow_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("grows.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    cultivar_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("cultivars.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    name: orm.Mapped[str] = orm.mapped_column(sa.String(120), nullable=False)
    propagation_source: orm.Mapped[str] = orm.mapped_column(sa.String(20), nullable=False)
    seed_type: orm.Mapped[str | None] = orm.mapped_column(sa.String(20))
    start_date: orm.Mapped[date | None] = orm.mapped_column(sa.Date)
    current_stage_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("lifecycle_stages.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    status: orm.Mapped[str] = orm.mapped_column(
        sa.String(20), default="planned", server_default="planned", nullable=False
    )
    container: orm.Mapped[str | None] = orm.mapped_column(sa.String(160))
    medium: orm.Mapped[str | None] = orm.mapped_column(sa.String(160))
    location: orm.Mapped[str | None] = orm.mapped_column(sa.String(200))
    expected_harvest_start: orm.Mapped[date | None] = orm.mapped_column(sa.Date)
    expected_harvest_end: orm.Mapped[date | None] = orm.mapped_column(sa.Date)
    actual_harvest_date: orm.Mapped[date | None] = orm.mapped_column(sa.Date)
    notes: orm.Mapped[str | None] = orm.mapped_column(sa.Text)
    cultivar: orm.Mapped[Cultivar] = orm.relationship(lazy="joined")
    grow: orm.Mapped[Grow] = orm.relationship(lazy="joined")
    current_stage: orm.Mapped[LifecycleStage] = orm.relationship(
        lazy="joined", foreign_keys=[current_stage_id]
    )
    transitions: orm.Mapped[list[PlantStageTransition]] = orm.relationship(
        back_populates="plant",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="PlantStageTransition.effective_at",
    )


class PlantStageTransition(UUIDPrimaryKeyMixin, Base):
    """Append-only record of one Plant stage transition."""

    __tablename__ = "plant_stage_transitions"
    __table_args__ = (
        sa.CheckConstraint(
            "source IN ('user_confirmed', 'user_adjusted', 'imported', "
            "'application_recalculation')",
            name="ck_transition_source",
        ),
        sa.Index(
            "ix_plant_transitions_order",
            "plant_id",
            "effective_at",
            "created_at",
        ),
    )

    plant_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("plants.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    from_stage_id: orm.Mapped[str | None] = orm.mapped_column(
        sa.ForeignKey("lifecycle_stages.id", ondelete="RESTRICT")
    )
    to_stage_id: orm.Mapped[str] = orm.mapped_column(
        sa.ForeignKey("lifecycle_stages.id", ondelete="RESTRICT"),
        nullable=False,
    )
    effective_at: orm.Mapped[datetime] = orm.mapped_column(
        sa.DateTime(timezone=True), nullable=False
    )
    source: orm.Mapped[str] = orm.mapped_column(sa.String(40), nullable=False)
    notes: orm.Mapped[str | None] = orm.mapped_column(sa.Text)
    created_at: orm.Mapped[datetime] = orm.mapped_column(
        sa.DateTime(timezone=True),
        server_default=sa.func.current_timestamp(),
        nullable=False,
    )
    plant: orm.Mapped[Plant] = orm.relationship(back_populates="transitions")
