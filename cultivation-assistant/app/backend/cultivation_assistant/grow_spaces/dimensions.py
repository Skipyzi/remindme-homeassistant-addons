"""Canonical Grow Space dimension conversion and derived measurements."""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum

FOUR_PLACES = Decimal("0.0001")
METRES_PER_CENTIMETRE = Decimal("0.01")
METRES_PER_INCH = Decimal("0.0254")
DISPLAY_PLACES = Decimal("0.01")


class DimensionUnit(StrEnum):
    """Units accepted for user-entered linear dimensions."""

    CM = "cm"
    IN = "in"


@dataclass(frozen=True, slots=True)
class CanonicalDimensions:
    """Positive linear dimensions represented in canonical metres."""

    length_m: Decimal
    width_m: Decimal
    height_m: Decimal | None


def _quantize(value: Decimal) -> Decimal:
    return value.quantize(FOUR_PLACES, rounding=ROUND_HALF_UP)


def to_metres(value: Decimal, unit: DimensionUnit) -> Decimal:
    """Convert one positive display dimension to canonical metres."""
    if value <= 0:
        raise ValueError("Dimension values must be positive")
    factor = METRES_PER_CENTIMETRE if unit is DimensionUnit.CM else METRES_PER_INCH
    return _quantize(value * factor)


def from_metres(value: Decimal, unit: DimensionUnit) -> Decimal:
    """Convert canonical metres into a concise display-unit value."""
    divisor = METRES_PER_CENTIMETRE if unit is DimensionUnit.CM else METRES_PER_INCH
    converted = value / divisor
    rounded = converted.quantize(DISPLAY_PLACES, rounding=ROUND_HALF_UP)
    if rounded == rounded.to_integral_value():
        return rounded.quantize(Decimal("1"))
    return rounded.normalize()


def derive_measurements(
    dimensions: CanonicalDimensions,
) -> tuple[Decimal, Decimal | None]:
    """Calculate floor area and optional volume from canonical dimensions."""
    area = _quantize(dimensions.length_m * dimensions.width_m)
    volume = (
        None
        if dimensions.height_m is None
        else _quantize(area * dimensions.height_m)
    )
    return area, volume
