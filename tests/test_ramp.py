"""Tests for deterministic sunrise ramp calculations."""

from datetime import timedelta

import pytest

from custom_components.sunrise_alarm.models import LightRampConfig, RampCurve
from custom_components.sunrise_alarm.ramp import (
    brightness_at,
    clamp_progress,
    curve_value,
    effective_interval,
    interpolate,
    kelvin_at,
    kelvin_to_rgb,
)


def ramp_config(*, curve: RampCurve = RampCurve.LINEAR) -> LightRampConfig:
    """Build a representative ramp configuration."""
    return LightRampConfig(
        entity_ids=("light.left",),
        duration=timedelta(minutes=30),
        start_brightness=1,
        end_brightness=100,
        start_kelvin=2200,
        end_kelvin=4000,
        curve=curve,
        update_interval=timedelta(seconds=10),
    )


@pytest.mark.parametrize(("value", "expected"), [(-1.0, 0.0), (0.4, 0.4), (2.0, 1.0)])
def test_clamp_progress(value: float, expected: float) -> None:
    """Progress is always bounded to the closed unit interval."""
    assert clamp_progress(value) == expected


def test_supported_curve_values() -> None:
    """Linear and natural curves produce their documented midpoint."""
    assert curve_value(RampCurve.LINEAR, 0.5) == 0.5
    assert curve_value(RampCurve.NATURAL, 0.5) == pytest.approx(0.5**2.2)


def test_interpolate_clamps_endpoints() -> None:
    """Interpolation never exceeds configured endpoints."""
    assert interpolate(10, 20, -1) == 10
    assert interpolate(10, 20, 2) == 20


def test_brightness_and_kelvin_outputs() -> None:
    """Linear outputs hit exact endpoints and midpoint."""
    config = ramp_config()

    assert brightness_at(config, 0.0) == 1
    assert brightness_at(config, 1.0) == 100
    assert kelvin_at(config, 0.5) == 3100


def test_kelvin_supports_reverse_direction() -> None:
    """Kelvin ramps may cool-to-warm as well as warm-to-cool."""
    config = ramp_config()
    reverse = LightRampConfig(
        config.entity_ids,
        config.duration,
        config.start_brightness,
        config.end_brightness,
        4000,
        2200,
        config.curve,
        config.update_interval,
    )

    assert kelvin_at(reverse, 0.0) == 4000
    assert kelvin_at(reverse, 1.0) == 2200


def test_effective_interval_caps_update_count() -> None:
    """Long ramps increase cadence enough to cap updates at 360."""
    assert effective_interval(timedelta(hours=2), timedelta(seconds=5)) == 20.0
    assert effective_interval(timedelta(minutes=30), timedelta(seconds=10)) == 10.0


@pytest.mark.parametrize("kelvin", [500, 1000, 2200, 6500, 10000, 12000])
def test_kelvin_to_rgb_is_bounded(kelvin: int) -> None:
    """Converted RGB channels are valid for every clamped Kelvin input."""
    rgb = kelvin_to_rgb(kelvin)

    assert len(rgb) == 3
    assert all(0 <= channel <= 255 for channel in rgb)


def test_kelvin_to_rgb_is_warmer_at_low_temperature() -> None:
    """A warm target has less blue than a daylight target."""
    warm = kelvin_to_rgb(2200)
    daylight = kelvin_to_rgb(6500)

    assert warm[2] < daylight[2]
