"""Tests for Sunrise Alarm recovery persistence."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest

from custom_components.sunrise_alarm.storage import AlarmStore, RecoveryRecord

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant


def valid_record() -> RecoveryRecord:
    """Build a representative active recovery record."""
    return RecoveryRecord(
        occurrence_id="2026-07-27T05:00:00+00:00",
        wake_time=datetime(2026, 7, 27, 5, tzinfo=UTC),
        sunrise_start=datetime(2026, 7, 27, 4, 30, tzinfo=UTC),
        phase="sunrise",
        skip_occurrence_id=None,
        skip_wake_time=None,
        last_successful=None,
        last_missed=None,
    )


def test_recovery_record_round_trip() -> None:
    """Aware timestamps survive serialization without ambiguity."""
    record = valid_record()

    assert RecoveryRecord.from_dict(record.to_dict()) == record


def test_recovery_record_rejects_unknown_schema() -> None:
    """Unknown record schemas are ignored safely."""
    payload = valid_record().to_dict() | {"schema_version": 99}

    with pytest.raises(ValueError, match="schema"):
        RecoveryRecord.from_dict(payload)


def test_recovery_record_rejects_naive_datetime() -> None:
    """Persisted runtime timestamps must be timezone-aware."""
    record = valid_record()
    invalid = RecoveryRecord(
        record.occurrence_id,
        datetime(2026, 7, 27, 5),  # noqa: DTZ001 - deliberately naive
        record.sunrise_start,
        record.phase,
        record.skip_occurrence_id,
        record.skip_wake_time,
        record.last_successful,
        record.last_missed,
    )

    with pytest.raises(ValueError, match="timezone-aware"):
        invalid.to_dict()


async def test_alarm_store_returns_none_when_missing(hass: HomeAssistant) -> None:
    """A new alarm has no recovery record."""
    store = AlarmStore(hass, "entry-1")

    assert await store.async_load() is None


async def test_alarm_store_round_trip(hass: HomeAssistant) -> None:
    """The HA store adapter saves, loads, and clears one alarm record."""
    store = AlarmStore(hass, "entry-1")
    record = valid_record()

    await store.async_save(record)
    assert await store.async_load() == record

    await store.async_clear()
    assert await store.async_load() is None
