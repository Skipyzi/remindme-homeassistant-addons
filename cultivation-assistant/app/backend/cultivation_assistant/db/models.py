# pyright: reportMissingImports=false
"""Foundation SQLAlchemy models."""

from __future__ import annotations

from datetime import datetime
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
