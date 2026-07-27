"""Tests for Sunrise Alarm domain models."""

from datetime import time
from typing import Any

import pytest

from custom_components.sunrise_alarm.models import AlarmConfig, RampCurve


def valid_data() -> dict[str, Any]:
    """Return valid immutable config-entry data."""
    return {
        "alarm_id": "alarm-1",
        "name": "Bedroom",
        "area_id": "bedroom",
        "provider": "fixed_schedule",
        "timezone": "Europe/Berlin",
    }


def valid_options() -> dict[str, Any]:
    """Return valid editable config-entry options."""
    return {
        "wake_time": "07:00:00",
        "weekdays": [0, 1, 2, 3, 4],
        "lights": ["light.left", "light.right"],
        "duration_minutes": 30,
        "start_brightness": 1,
        "end_brightness": 100,
        "start_kelvin": 2200,
        "end_kelvin": 4000,
        "curve": "natural",
        "update_interval": 10,
        "stop_on_manual_off": False,
        "enabled": True,
    }


def test_alarm_config_from_mappings() -> None:
    """Valid mappings produce typed immutable configuration."""
    config = AlarmConfig.from_mappings(valid_data(), valid_options())

    assert config.schedule.wake_time == time(7, 0)
    assert config.schedule.weekdays == frozenset({0, 1, 2, 3, 4})
    assert config.ramp.curve is RampCurve.NATURAL
    assert config.area_id == "bedroom"


def test_alarm_config_rejects_no_weekdays() -> None:
    """A weekly schedule must select at least one weekday."""
    options = valid_options() | {"weekdays": []}

    with pytest.raises(ValueError, match="weekday"):
        AlarmConfig.from_mappings(valid_data(), options)


@pytest.mark.parametrize(
    ("key", "value", "message"),
    [
        ("lights", [], "light"),
        ("start_brightness", 0, "brightness"),
        ("end_brightness", 0, "brightness"),
        ("start_kelvin", 999, "Kelvin"),
        ("end_kelvin", 10001, "Kelvin"),
        ("update_interval", 4, "interval"),
    ],
)
def test_alarm_config_rejects_invalid_options(
    key: str, value: object, message: str
) -> None:
    """Invalid editable ranges are rejected at the model boundary."""
    options = valid_options() | {key: value}

    with pytest.raises(ValueError, match=message):
        AlarmConfig.from_mappings(valid_data(), options)


def test_alarm_config_rejects_unknown_provider() -> None:
    """Only the fixed provider is implemented in this slice."""
    data = valid_data() | {"provider": "apple_shortcut"}

    with pytest.raises(ValueError, match="provider"):
        AlarmConfig.from_mappings(data, valid_options())
