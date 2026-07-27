"""DST-aware weekly schedule calculations."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from zoneinfo import ZoneInfo

from .models import AlarmOccurrence, FixedScheduleConfig

_DEFAULT_SEARCH_LIMIT = timedelta(hours=4)
_MAX_DATES_TO_CHECK = 8


def _valid_candidates(local_naive: datetime, timezone: ZoneInfo) -> list[datetime]:
    """Return aware candidates that round-trip to a local wall time."""
    candidates: list[datetime] = []
    for fold in (0, 1):
        candidate = local_naive.replace(tzinfo=timezone, fold=fold)
        round_trip = candidate.astimezone(UTC).astimezone(timezone)
        if round_trip.replace(tzinfo=None) == local_naive and round_trip.fold == fold:
            candidates.append(candidate)
    return candidates


def resolve_local_datetime(
    local_date: date,
    wall_time: time,
    timezone: ZoneInfo,
    *,
    search_limit: timedelta = _DEFAULT_SEARCH_LIMIT,
) -> datetime:
    """Resolve a local wall time according to the documented DST policy."""
    if search_limit < timedelta(0):
        msg = "search limit cannot be negative"
        raise ValueError(msg)

    requested = datetime.combine(local_date, wall_time.replace(tzinfo=None))
    elapsed = timedelta(0)
    while elapsed <= search_limit:
        if candidates := _valid_candidates(requested + elapsed, timezone):
            return candidates[0]
        elapsed += timedelta(seconds=1)

    msg = "No valid local time found within the search limit"
    raise ValueError(msg)


def occurrence_id_for(wake_time: datetime) -> str:
    """Return an unambiguous stable occurrence identifier."""
    if wake_time.tzinfo is None or wake_time.utcoffset() is None:
        msg = "wake time must be timezone-aware"
        raise ValueError(msg)
    return wake_time.astimezone(UTC).isoformat()


def next_occurrence(
    now: datetime,
    schedule: FixedScheduleConfig,
    duration: timedelta,
    skip_id: str | None = None,
) -> AlarmOccurrence:
    """Calculate the next eligible weekly occurrence."""
    if now.tzinfo is None or now.utcoffset() is None:
        msg = "now must be timezone-aware"
        raise ValueError(msg)
    if duration <= timedelta(0):
        msg = "duration must be positive"
        raise ValueError(msg)
    if not schedule.weekdays:
        msg = "At least one weekday is required"
        raise ValueError(msg)

    local_now = now.astimezone(schedule.timezone)
    for day_offset in range(_MAX_DATES_TO_CHECK):
        local_date = local_now.date() + timedelta(days=day_offset)
        if local_date.weekday() not in schedule.weekdays:
            continue

        wake_time = resolve_local_datetime(
            local_date,
            schedule.wake_time,
            schedule.timezone,
        )
        if wake_time <= now:
            continue

        occurrence_id = occurrence_id_for(wake_time)
        if occurrence_id == skip_id:
            continue

        sunrise_start = (wake_time.astimezone(UTC) - duration).astimezone(
            schedule.timezone
        )
        return AlarmOccurrence(occurrence_id, wake_time, sunrise_start)

    msg = "Unable to find an eligible occurrence within eight local dates"
    raise ValueError(msg)
