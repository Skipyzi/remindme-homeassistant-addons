"""Shared helper for constructing consequential audit records."""

from datetime import UTC, datetime
from typing import Any

from cultivation_assistant.db.models import AuditLog


def audit_record(
    action: str,
    resource_type: str,
    resource_id: str,
    correlation_id: str,
    *,
    details: dict[str, Any] | None = None,
) -> AuditLog:
    """Build one audit row inside the caller-owned transaction."""
    return AuditLog(
        occurred_at=datetime.now(UTC),
        actor="local_user",
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        correlation_id=correlation_id or None,
        details=details or {},
    )
