"""Tank-geometry volume math and calibration-table interpolation.

All results are liters, quantized to four decimal places to match the
precision discipline used elsewhere for physical measurements
(`grow_spaces/dimensions.py`).
"""

import math
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum

FOUR_PLACES = Decimal("0.0001")
PI = Decimal(str(math.pi))
CUBIC_METRES_TO_LITERS = Decimal("1000")

LEVEL_ROLE_PRIORITY: tuple[str, ...] = ("level_percentage", "liquid_depth", "distance_to_liquid")


class GeometryShape(StrEnum):
    """Supported tank geometry shapes for this slice."""

    RECTANGULAR = "rectangular"
    VERTICAL_CYLINDER = "vertical_cylinder"
    HORIZONTAL_CYLINDER = "horizontal_cylinder"
    CUSTOM_CALIBRATION_TABLE = "custom_calibration_table"


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(FOUR_PLACES, rounding=ROUND_HALF_UP)


def volume_from_depth(
    shape: GeometryShape,
    dimensions: dict[str, Decimal],
    depth_m: Decimal,
) -> Decimal:
    """Compute the liquid volume in liters for a given fill depth."""
    if shape is GeometryShape.RECTANGULAR:
        area = dimensions["length_m"] * dimensions["width_m"]
        return _quantize(area * depth_m * CUBIC_METRES_TO_LITERS)

    if shape is GeometryShape.VERTICAL_CYLINDER:
        radius = dimensions["diameter_m"] / 2
        area = PI * radius * radius
        return _quantize(area * depth_m * CUBIC_METRES_TO_LITERS)

    if shape is GeometryShape.HORIZONTAL_CYLINDER:
        return _horizontal_cylinder_volume(dimensions, depth_m)

    raise ValueError(f"volume_from_depth does not support shape {shape!r}")


def _horizontal_cylinder_volume(dimensions: dict[str, Decimal], depth_m: Decimal) -> Decimal:
    # The circular-segment area formula needs acos/sqrt, which Decimal
    # cannot compute; float precision is more than sufficient for a
    # physical tank-fill estimate.
    radius = float(dimensions["diameter_m"]) / 2
    length = float(dimensions["length_m"])
    depth = min(max(float(depth_m), 0.0), 2 * radius)
    if radius <= 0:
        raise ValueError("Horizontal cylinder diameter must be positive")
    height_from_center = radius - depth
    chord_term = height_from_center * math.sqrt(max(2 * radius * depth - depth**2, 0.0))
    segment_area = radius**2 * math.acos(height_from_center / radius) - chord_term
    volume_m3 = segment_area * length
    return _quantize(Decimal(str(volume_m3)) * CUBIC_METRES_TO_LITERS)


def volume_from_percentage(usable_capacity_liters: Decimal, percentage: Decimal) -> Decimal:
    """Compute volume in liters from a 0-1 fill percentage of usable capacity."""
    return _quantize(usable_capacity_liters * percentage)


def interpolate_calibration(
    points: list[tuple[Decimal, Decimal]],
    raw_value: Decimal,
) -> Decimal:
    """Linearly interpolate volume from a calibration table, clamped at its ends."""
    ordered = sorted(points, key=lambda point: point[0])
    if raw_value <= ordered[0][0]:
        return _quantize(ordered[0][1])
    if raw_value >= ordered[-1][0]:
        return _quantize(ordered[-1][1])
    for (low_raw, low_volume), (high_raw, high_volume) in zip(ordered, ordered[1:], strict=False):
        if low_raw <= raw_value <= high_raw:
            span = high_raw - low_raw
            fraction = (raw_value - low_raw) / span
            return _quantize(low_volume + (high_volume - low_volume) * fraction)
    raise ValueError("raw_value fell outside the calibration table")
