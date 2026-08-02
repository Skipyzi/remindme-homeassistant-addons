"""Domain models for Sunrise Alarm."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from enum import StrEnum
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

if TYPE_CHECKING:
    from collections.abc import Mapping
    from typing import Any

from .const import (
    CONF_ALARM_ID,
    CONF_AREA_ID,
    CONF_CURVE,
    CONF_DURATION_MINUTES,
    CONF_ENABLED,
    CONF_END_BRIGHTNESS,
    CONF_END_KELVIN,
    CONF_LIGHTS,
    CONF_NAME,
    CONF_PROVIDER,
    CONF_START_BRIGHTNESS,
    CONF_START_KELVIN,
    CONF_STOP_ON_MANUAL_OFF,
    CONF_TIMEZONE,
    CONF_UPDATE_INTERVAL,
    CONF_WAKE_TIME,
    CONF_WEEKDAYS,
    MAX_BRIGHTNESS,
    MAX_KELVIN,
    MAX_UPDATE_INTERVAL,
    MIN_BRIGHTNESS,
    MIN_KELVIN,
    MIN_UPDATE_INTERVAL,
    PROVIDER_FIXED_SCHEDULE,
)


class AlarmState(StrEnum):
    """Operational state of one alarm controller."""

    DISABLED = "disabled"
    SCHEDULED = "scheduled"
    SUNRISE = "sunrise"
    PREVIEWING = "previewing"
    ERROR = "error"


class RampCurve(StrEnum):
    """Supported sunrise ramp curves."""

    LINEAR = "linear"
    NATURAL = "natural"


@dataclass(frozen=True, slots=True)
class FixedScheduleConfig:
    """Fixed weekly schedule configuration."""

    wake_time: time
    weekdays: frozenset[int]
    timezone: ZoneInfo


@dataclass(frozen=True, slots=True)
class LightRampConfig:
    """Light output ramp configuration."""

    entity_ids: tuple[str, ...]
    duration: timedelta
    start_brightness: int
    end_brightness: int
    start_kelvin: int
    end_kelvin: int
    curve: RampCurve
    update_interval: timedelta


@dataclass(frozen=True, slots=True)
class AlarmConfig:
    """Validated configuration for one alarm."""

    alarm_id: str
    name: str
    area_id: str | None
    provider: str
    schedule: FixedScheduleConfig
    ramp: LightRampConfig
    stop_on_manual_off: bool
    enabled: bool

    @classmethod
    def from_mappings(
        cls, data: Mapping[str, Any], options: Mapping[str, Any]
    ) -> AlarmConfig:
        """Parse and validate config-entry mappings."""
        provider = str(data[CONF_PROVIDER])
        if provider != PROVIDER_FIXED_SCHEDULE:
            msg = f"Unsupported alarm provider: {provider}"
            raise ValueError(msg)

        try:
            timezone = ZoneInfo(str(data[CONF_TIMEZONE]))
        except ZoneInfoNotFoundError as err:
            msg = f"Invalid timezone: {data[CONF_TIMEZONE]}"
            raise ValueError(msg) from err

        wake_time = time.fromisoformat(str(options[CONF_WAKE_TIME]))
        weekdays = frozenset(int(day) for day in options[CONF_WEEKDAYS])
        if not weekdays or not weekdays.issubset(range(7)):
            msg = "At least one valid weekday is required"
            raise ValueError(msg)

        entity_ids = tuple(str(entity_id) for entity_id in options[CONF_LIGHTS])
        if not entity_ids:
            msg = "At least one light is required"
            raise ValueError(msg)

        start_brightness = int(options[CONF_START_BRIGHTNESS])
        end_brightness = int(options[CONF_END_BRIGHTNESS])
        if not MIN_BRIGHTNESS <= start_brightness <= MAX_BRIGHTNESS or not (
            MIN_BRIGHTNESS <= end_brightness <= MAX_BRIGHTNESS
        ):
            msg = "brightness must be between 1 and 100"
            raise ValueError(msg)
        if end_brightness < start_brightness:
            msg = "final brightness cannot be below initial brightness"
            raise ValueError(msg)

        start_kelvin = int(options[CONF_START_KELVIN])
        end_kelvin = int(options[CONF_END_KELVIN])
        if not MIN_KELVIN <= start_kelvin <= MAX_KELVIN or not (
            MIN_KELVIN <= end_kelvin <= MAX_KELVIN
        ):
            msg = "Kelvin values must be between 1000 and 10000"
            raise ValueError(msg)

        duration_minutes = int(options[CONF_DURATION_MINUTES])
        if duration_minutes <= 0:
            msg = "Sunrise duration must be positive"
            raise ValueError(msg)

        update_interval = int(options[CONF_UPDATE_INTERVAL])
        if not MIN_UPDATE_INTERVAL <= update_interval <= MAX_UPDATE_INTERVAL:
            msg = "Update interval must be between 5 and 60 seconds"
            raise ValueError(msg)

        return cls(
            alarm_id=str(data[CONF_ALARM_ID]),
            name=str(data[CONF_NAME]),
            area_id=(
                str(data[CONF_AREA_ID]) if data.get(CONF_AREA_ID) is not None else None
            ),
            provider=provider,
            schedule=FixedScheduleConfig(wake_time, weekdays, timezone),
            ramp=LightRampConfig(
                entity_ids=entity_ids,
                duration=timedelta(minutes=duration_minutes),
                start_brightness=start_brightness,
                end_brightness=end_brightness,
                start_kelvin=start_kelvin,
                end_kelvin=end_kelvin,
                curve=RampCurve(str(options[CONF_CURVE])),
                update_interval=timedelta(seconds=update_interval),
            ),
            stop_on_manual_off=bool(options[CONF_STOP_ON_MANUAL_OFF]),
            enabled=bool(options[CONF_ENABLED]),
        )


@dataclass(frozen=True, slots=True)
class AlarmOccurrence:
    """One calculated alarm execution."""

    occurrence_id: str
    wake_time: datetime
    sunrise_start: datetime
