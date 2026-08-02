"""Tests for fixed weekly scheduling."""

from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from custom_components.sunrise_alarm.models import FixedScheduleConfig
from custom_components.sunrise_alarm.schedule import (
    next_occurrence,
    occurrence_id_for,
    resolve_local_datetime,
)

BERLIN = ZoneInfo("Europe/Berlin")
DURATION = timedelta(minutes=30)


def schedule_at(wake_time: time, weekdays: set[int]) -> FixedScheduleConfig:
    """Build a Berlin weekly schedule."""
    return FixedScheduleConfig(wake_time, frozenset(weekdays), BERLIN)


def test_alarm_later_today() -> None:
    """A future alarm on an enabled weekday runs today."""
    now = datetime(2026, 7, 27, 6, 0, tzinfo=BERLIN)

    result = next_occurrence(now, schedule_at(time(7), {0}), DURATION)

    assert result.wake_time == datetime(2026, 7, 27, 7, 0, tzinfo=BERLIN)
    assert result.sunrise_start == datetime(2026, 7, 27, 6, 30, tzinfo=BERLIN)


def test_alarm_already_passed_rolls_one_week() -> None:
    """A passed alarm with one active weekday moves to the next week."""
    now = datetime(2026, 7, 27, 8, 0, tzinfo=BERLIN)

    result = next_occurrence(now, schedule_at(time(7), {0}), DURATION)

    assert result.wake_time.date() == date(2026, 8, 3)


def test_friday_rolls_to_monday() -> None:
    """A weekday schedule rolls across the weekend."""
    now = datetime(2026, 7, 24, 8, 0, tzinfo=BERLIN)

    result = next_occurrence(now, schedule_at(time(7), {0, 1, 2, 3, 4}), DURATION)

    assert result.wake_time == datetime(2026, 7, 27, 7, 0, tzinfo=BERLIN)


def test_skip_excludes_only_exact_occurrence() -> None:
    """Skip targets one occurrence and leaves the recurring rule intact."""
    now = datetime(2026, 7, 27, 6, 0, tzinfo=BERLIN)
    schedule = schedule_at(time(7), {0, 1, 2, 3, 4})
    first = next_occurrence(now, schedule, DURATION)

    result = next_occurrence(now, schedule, DURATION, first.occurrence_id)

    assert result.wake_time == datetime(2026, 7, 28, 7, 0, tzinfo=BERLIN)


def test_spring_gap_uses_first_valid_local_time() -> None:
    """A nonexistent 02:30 alarm runs at the first valid 03:00 time."""
    now = datetime(2026, 3, 28, 12, 0, tzinfo=BERLIN)

    result = next_occurrence(now, schedule_at(time(2, 30), {6}), DURATION)

    assert result.wake_time.isoformat() == "2026-03-29T03:00:00+02:00"
    assert (
        result.wake_time.astimezone(UTC) - result.sunrise_start.astimezone(UTC)
        == DURATION
    )


def test_autumn_repetition_uses_first_fold() -> None:
    """A repeated alarm uses the first occurrence only."""
    now = datetime(2026, 10, 24, 12, 0, tzinfo=BERLIN)

    result = next_occurrence(now, schedule_at(time(2, 30), {6}), DURATION)

    assert result.wake_time.isoformat() == "2026-10-25T02:30:00+02:00"
    assert result.wake_time.fold == 0


def test_resolve_local_datetime_rejects_no_valid_time_within_bound() -> None:
    """The resolver has a bounded search for pathological timezone data."""
    with pytest.raises(ValueError, match="valid local time"):
        resolve_local_datetime(
            date(2026, 3, 29),
            time(2, 30),
            BERLIN,
            search_limit=timedelta(seconds=0),
        )


def test_next_occurrence_rejects_naive_now() -> None:
    """Occurrence comparisons require an aware current timestamp."""
    with pytest.raises(ValueError, match="timezone-aware"):
        next_occurrence(
            datetime(2026, 7, 27, 6),  # noqa: DTZ001 - deliberately naive
            schedule_at(time(7), {0}),
            DURATION,
        )


def test_occurrence_id_is_utc_iso_timestamp() -> None:
    """Occurrence identity is unambiguous across timezone changes."""
    wake = datetime(2026, 7, 27, 7, 0, tzinfo=BERLIN)

    assert occurrence_id_for(wake) == "2026-07-27T05:00:00+00:00"
