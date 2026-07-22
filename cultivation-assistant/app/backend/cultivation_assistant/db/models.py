# pyright: reportMissingImports=false
"""Foundation SQLAlchemy models."""

from datetime import datetime
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
