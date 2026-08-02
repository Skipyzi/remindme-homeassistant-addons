"""Pure sunrise ramp calculations."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from datetime import timedelta

from .const import MAX_KELVIN, MIN_KELVIN
from .models import LightRampConfig, RampCurve

_MAX_UPDATES = 360
_RGB_MIN = 0
_RGB_MAX = 255
_TEMPERATURE_SCALE = 100
_RED_GREEN_THRESHOLD = 66
_BLUE_ZERO_THRESHOLD = 19


def clamp_progress(progress: float) -> float:
    """Clamp progress to the closed unit interval."""
    return max(0.0, min(progress, 1.0))


def curve_value(curve: RampCurve, progress: float) -> float:
    """Apply a supported curve to bounded progress."""
    bounded = clamp_progress(progress)
    if curve is RampCurve.LINEAR:
        return bounded
    return float(bounded**2.2)


def interpolate(start: float, end: float, progress: float) -> float:
    """Interpolate between numeric endpoints."""
    return start + clamp_progress(progress) * (end - start)


def effective_interval(duration: timedelta, requested: timedelta) -> float:
    """Return a cadence that never exceeds 360 updates."""
    return max(requested.total_seconds(), duration.total_seconds() / _MAX_UPDATES)


def brightness_at(config: LightRampConfig, progress: float) -> int:
    """Calculate rounded brightness percentage at progress."""
    curved = curve_value(config.curve, progress)
    return round(interpolate(config.start_brightness, config.end_brightness, curved))


def kelvin_at(config: LightRampConfig, progress: float) -> int:
    """Calculate rounded colour temperature at progress."""
    curved = curve_value(config.curve, progress)
    return round(interpolate(config.start_kelvin, config.end_kelvin, curved))


def _channel(value: float) -> int:
    """Clamp and round one RGB channel."""
    return round(max(_RGB_MIN, min(value, _RGB_MAX)))


def kelvin_to_rgb(kelvin: int) -> tuple[int, int, int]:
    """Approximate a Kelvin colour temperature as an RGB tuple."""
    temperature = max(MIN_KELVIN, min(kelvin, MAX_KELVIN)) / _TEMPERATURE_SCALE
    red: float
    green: float
    blue: float

    if temperature <= _RED_GREEN_THRESHOLD:
        red = _RGB_MAX
        green = 99.4708025861 * math.log(temperature) - 161.1195681661
    else:
        red = 329.698727446 * ((temperature - 60) ** -0.1332047592)
        green = 288.1221695283 * ((temperature - 60) ** -0.0755148492)

    if temperature >= _RED_GREEN_THRESHOLD:
        blue = _RGB_MAX
    elif temperature <= _BLUE_ZERO_THRESHOLD:
        blue = _RGB_MIN
    else:
        blue = 138.5177312231 * math.log(temperature - 10) - 305.0447927307

    return (_channel(red), _channel(green), _channel(blue))
