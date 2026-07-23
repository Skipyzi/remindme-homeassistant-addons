"""Unit compatibility and deterministic Decimal normalization."""

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from cultivation_assistant.grow_spaces.roles import get_role_definition


class Compatibility(StrEnum):
    """How safely an entity unit can satisfy a semantic role."""

    COMPATIBLE = "compatible"
    CONVERTIBLE = "convertible"
    UNKNOWN = "unknown"
    INCOMPATIBLE = "incompatible"


@dataclass(frozen=True, slots=True)
class UnitCompatibility:
    """Unit validation result returned by discovery and mapping validation."""

    compatibility: Compatibility
    source_unit: str | None
    normalized_unit: str | None


_UNIT_ALIASES = {
    "c": "°C",
    "°c": "°C",
    "celsius": "°C",
    "f": "°F",
    "°f": "°F",
    "fahrenheit": "°F",
    "kelvin": "K",
    "percent": "%",
    "lux": "lx",
    "umol/m2/s": "µmol/m²/s",
    "μmol/m²/s": "µmol/m²/s",
    "µmol/m2/s": "µmol/m²/s",
    "watt": "W",
    "watts": "W",
    "kilowatt": "kW",
    "kilowatts": "kW",
    "watt-hour": "Wh",
    "watt-hours": "Wh",
    "kilowatt-hour": "kWh",
    "kilowatt-hours": "kWh",
}

_CONVERTIBLE_UNITS = {
    ("°F", "°C"),
    ("K", "°C"),
    ("kW", "W"),
    ("Wh", "kWh"),
    ("Pa", "kPa"),
    ("hPa", "kPa"),
}

_AREA_FACTORS = {
    "m²": Decimal("1"),
    "m2": Decimal("1"),
    "ft²": Decimal("0.09290304"),
    "ft2": Decimal("0.09290304"),
}

_VOLUME_FACTORS = {
    "m³": Decimal("1"),
    "m3": Decimal("1"),
    "ft³": Decimal("0.028316846592"),
    "ft3": Decimal("0.028316846592"),
}


def _canonical_source_unit(source_unit: str) -> str:
    stripped = source_unit.strip()
    return _UNIT_ALIASES.get(stripped.casefold(), stripped)


def classify_unit(role: str, source_unit: str | None) -> UnitCompatibility:
    """Classify a source unit against the selected semantic role."""
    definition = get_role_definition(role)
    if source_unit is None or not source_unit.strip():
        compatibility = (
            Compatibility.COMPATIBLE if definition.canonical_unit is None else Compatibility.UNKNOWN
        )
        return UnitCompatibility(compatibility, None, definition.canonical_unit)

    canonical_source = _canonical_source_unit(source_unit)
    if canonical_source == definition.canonical_unit:
        compatibility = Compatibility.COMPATIBLE
    elif (canonical_source, definition.canonical_unit) in _CONVERTIBLE_UNITS:
        compatibility = Compatibility.CONVERTIBLE
    elif canonical_source in definition.source_units:
        compatibility = Compatibility.COMPATIBLE
    else:
        compatibility = Compatibility.INCOMPATIBLE
    return UnitCompatibility(compatibility, canonical_source, definition.canonical_unit)


def normalize_environment_value(
    role: str,
    value: Decimal,
    source_unit: str,
) -> Decimal:
    """Convert a compatible environmental value to its role's canonical unit."""
    result = classify_unit(role, source_unit)
    if result.compatibility in {Compatibility.UNKNOWN, Compatibility.INCOMPATIBLE}:
        raise ValueError(f"Unit {source_unit!r} is not compatible with role {role!r}")

    unit = result.source_unit
    if unit == "°F":
        return (value - Decimal("32")) * Decimal("5") / Decimal("9")
    if unit == "K":
        return value - Decimal("273.15")
    if unit == "kW":
        return value * Decimal("1000")
    if unit == "Wh":
        return value / Decimal("1000")
    if unit == "Pa":
        return value / Decimal("1000")
    if unit == "hPa":
        return value / Decimal("10")
    return value


def _normalize_dimension(
    value: Decimal,
    unit: str,
    factors: dict[str, Decimal],
    dimension_name: str,
) -> Decimal:
    if value <= 0:
        raise ValueError(f"{dimension_name} must be positive")
    try:
        factor = factors[unit.strip()]
    except KeyError as exc:
        raise ValueError(f"Unsupported {dimension_name} unit: {unit}") from exc
    return value * factor


def normalize_area(value: Decimal, unit: str) -> Decimal:
    """Normalize a positive area to square metres."""
    return _normalize_dimension(value, unit, _AREA_FACTORS, "area")


def normalize_volume(value: Decimal, unit: str) -> Decimal:
    """Normalize a positive volume to cubic metres."""
    return _normalize_dimension(value, unit, _VOLUME_FACTORS, "volume")
