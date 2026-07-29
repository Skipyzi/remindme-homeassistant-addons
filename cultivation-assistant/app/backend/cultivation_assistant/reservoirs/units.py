"""Unit compatibility and normalization for reservoir entity mappings."""

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from cultivation_assistant.reservoirs.roles import get_role_definition


class Compatibility(StrEnum):
    """How safely an entity unit can satisfy a reservoir role."""

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
    "kilogram": "kg",
    "kilograms": "kg",
    "gram": "g",
    "grams": "g",
    "pound": "lb",
    "pounds": "lb",
    "lbs": "lb",
    "centimeter": "cm",
    "centimetre": "cm",
    "centimeters": "cm",
    "centimetres": "cm",
    "meter": "m",
    "metre": "m",
    "meters": "m",
    "metres": "m",
    "millimeter": "mm",
    "millimetre": "mm",
    "inch": "in",
    "inches": "in",
    "l/min": "L/min",
    "gal/min": "gal/min",
}

_CONVERTIBLE_UNITS = {
    ("°F", "°C"),
    ("K", "°C"),
    ("m", "cm"),
    ("mm", "cm"),
    ("in", "cm"),
    ("g", "kg"),
    ("lb", "kg"),
    ("gal/min", "L/min"),
}

_LENGTH_TO_METRES = {
    "m": Decimal("1"),
    "cm": Decimal("0.01"),
    "mm": Decimal("0.001"),
    "in": Decimal("0.0254"),
}

_WEIGHT_TO_KG = {
    "kg": Decimal("1"),
    "g": Decimal("0.001"),
    "lb": Decimal("0.45359237"),
}


def _canonical_source_unit(source_unit: str) -> str:
    stripped = source_unit.strip()
    return _UNIT_ALIASES.get(stripped.casefold(), stripped)


def classify_unit(role: str, source_unit: str | None) -> UnitCompatibility:
    """Classify a source unit against the selected reservoir role."""
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


def normalize_length_to_metres(value: Decimal, unit: str) -> Decimal:
    """Convert a positive length reading to metres."""
    if value < 0:
        raise ValueError("Length values must not be negative")
    canonical = _canonical_source_unit(unit)
    try:
        factor = _LENGTH_TO_METRES[canonical]
    except KeyError as exc:
        raise ValueError(f"Unsupported length unit: {unit}") from exc
    return value * factor


def normalize_weight_to_kg(value: Decimal, unit: str) -> Decimal:
    """Convert a positive weight reading to kilograms."""
    if value < 0:
        raise ValueError("Weight values must not be negative")
    canonical = _canonical_source_unit(unit)
    try:
        factor = _WEIGHT_TO_KG[canonical]
    except KeyError as exc:
        raise ValueError(f"Unsupported weight unit: {unit}") from exc
    return value * factor


_LENGTH_TO_CM: dict[str, Decimal] = {
    "cm": Decimal("1"),
    "m": Decimal("100"),
    "mm": Decimal("0.1"),
    "in": Decimal("2.54"),
}

_FLOW_TO_LPM: dict[str, Decimal] = {
    "L/min": Decimal("1"),
    "gal/min": Decimal("3.785411784"),
}

_ON_STATES: frozenset[str] = frozenset({"on", "true", "wet", "detected", "open"})


def _binary_role_for(role: str) -> bool:
    """Whether a role reports a binary on/off state rather than a numeric value."""
    return role in {
        "low_level",
        "empty",
        "high_level",
        "overflow",
        "leak",
        "pump",
        "fill_valve",
    }


def normalize_reservoir_value(
    role: str,
    value: Decimal,
    source_unit: str | None,
) -> Decimal:
    """Convert a compatible reservoir reading to its role's canonical unit.

    Mirrors the grow-spaces `normalize_environment_value` contract: the caller
    has already classified the unit as compatible or convertible. Raises
    `ValueError` when the unit cannot be normalized.
    """
    if _binary_role_for(role):
        raise ValueError(f"Role {role!r} is binary and is not normalized as a number")

    if role == "level_percentage":
        return value

    if source_unit is None:
        raise ValueError(f"Role {role!r} requires a source unit to normalize")

    canonical = _canonical_source_unit(source_unit)

    if role == "water_temperature":
        if canonical == "°F":
            return (value - Decimal("32")) * Decimal("5") / Decimal("9")
        if canonical == "K":
            return value - Decimal("273.15")
        return value  # already °C

    if role in {"liquid_depth", "distance_to_liquid"}:
        try:
            factor = _LENGTH_TO_CM[canonical]
        except KeyError as exc:
            raise ValueError(f"Unsupported length unit: {source_unit}") from exc
        return value * factor

    if role == "weight":
        return normalize_weight_to_kg(value, source_unit)

    if role == "flow":
        try:
            factor = _FLOW_TO_LPM[canonical]
        except KeyError as exc:
            raise ValueError(f"Unsupported flow unit: {source_unit}") from exc
        return value * factor

    raise ValueError(f"No normalizer registered for role {role!r}")


def is_binary_reservoir_role(role: str) -> bool:
    """Expose the binary-role classification for live-readings callers."""
    return _binary_role_for(role)


def binary_state_value(raw_state: str) -> bool:
    """Normalize a Home Assistant on/off string to a boolean."""
    return raw_state.casefold() in _ON_STATES
