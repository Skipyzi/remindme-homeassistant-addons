"""Versioned runtime persistence for Sunrise Alarm."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Final

from homeassistant.helpers.storage import Store

from .const import DOMAIN

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant

_LOGGER = logging.getLogger(__name__)
_SCHEMA_VERSION: Final = 1
_STORE_VERSION: Final = 1


def _ensure_aware(value: datetime) -> datetime:
    """Return an aware datetime or raise a validation error."""
    if value.tzinfo is None or value.utcoffset() is None:
        msg = "Recovery timestamps must be timezone-aware"
        raise ValueError(msg)
    return value


def _serialize(value: datetime | None) -> str | None:
    """Serialize one optional datetime in UTC."""
    if value is None:
        return None
    return _ensure_aware(value).astimezone(UTC).isoformat()


def _parse(value: object) -> datetime | None:
    """Parse one optional aware ISO timestamp."""
    if value is None:
        return None
    if not isinstance(value, str):
        msg = "Recovery timestamp must be an ISO 8601 string"
        raise TypeError(msg)
    return _ensure_aware(datetime.fromisoformat(value))


@dataclass(frozen=True, slots=True)
class RecoveryRecord:
    """Minimal persisted runtime state for one alarm."""

    occurrence_id: str | None
    wake_time: datetime | None
    sunrise_start: datetime | None
    phase: str | None
    skip_occurrence_id: str | None
    skip_wake_time: datetime | None
    last_successful: datetime | None
    last_missed: datetime | None

    def to_dict(self) -> dict[str, Any]:
        """Serialize this record for Home Assistant storage."""
        return {
            "schema_version": _SCHEMA_VERSION,
            "occurrence_id": self.occurrence_id,
            "wake_time": _serialize(self.wake_time),
            "sunrise_start": _serialize(self.sunrise_start),
            "phase": self.phase,
            "skip_occurrence_id": self.skip_occurrence_id,
            "skip_wake_time": _serialize(self.skip_wake_time),
            "last_successful": _serialize(self.last_successful),
            "last_missed": _serialize(self.last_missed),
        }

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> RecoveryRecord:
        """Parse a strict versioned storage payload."""
        if payload.get("schema_version") != _SCHEMA_VERSION:
            msg = "Unsupported recovery schema version"
            raise ValueError(msg)
        return cls(
            occurrence_id=_optional_string(payload.get("occurrence_id")),
            wake_time=_parse(payload.get("wake_time")),
            sunrise_start=_parse(payload.get("sunrise_start")),
            phase=_optional_string(payload.get("phase")),
            skip_occurrence_id=_optional_string(payload.get("skip_occurrence_id")),
            skip_wake_time=_parse(payload.get("skip_wake_time")),
            last_successful=_parse(payload.get("last_successful")),
            last_missed=_parse(payload.get("last_missed")),
        )


def _optional_string(value: object) -> str | None:
    """Validate one optional persisted string."""
    if value is None:
        return None
    if not isinstance(value, str):
        msg = "Recovery identifier and phase values must be strings"
        raise TypeError(msg)
    return value


class AlarmStore:
    """Persist recovery data for one config entry."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        """Initialize the versioned store."""
        self._hass = hass
        self._key = f"{DOMAIN}.{entry_id}"
        self._store = self._new_store()

    def _new_store(self) -> Store[dict[str, Any]]:
        """Create a Store without retained in-memory write data."""
        return Store[dict[str, Any]](self._hass, _STORE_VERSION, self._key)

    async def async_load(self) -> RecoveryRecord | None:
        """Load and validate the current record."""
        if (payload := await self._store.async_load()) is None:
            return None
        try:
            return RecoveryRecord.from_dict(payload)
        except KeyError, TypeError, ValueError:
            _LOGGER.warning("Ignoring invalid Sunrise Alarm recovery record")
            return None

    async def async_save(self, record: RecoveryRecord) -> None:
        """Persist one recovery record immediately."""
        await self._store.async_save(record.to_dict())

    async def async_clear(self) -> None:
        """Remove persisted recovery data."""
        await self._store.async_remove()
        self._store = self._new_store()
