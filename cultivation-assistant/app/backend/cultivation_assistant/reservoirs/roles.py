"""Semantic role definitions for reservoir entity mappings."""

from dataclasses import dataclass
from enum import StrEnum


class ReservoirRole(StrEnum):
    """Home Assistant roles supported by reservoir entity mappings."""

    LEVEL_PERCENTAGE = "level_percentage"
    LIQUID_DEPTH = "liquid_depth"
    DISTANCE_TO_LIQUID = "distance_to_liquid"
    WEIGHT = "weight"
    WATER_TEMPERATURE = "water_temperature"
    LOW_LEVEL = "low_level"
    EMPTY = "empty"
    HIGH_LEVEL = "high_level"
    OVERFLOW = "overflow"
    LEAK = "leak"
    PUMP = "pump"
    FILL_VALVE = "fill_valve"
    FLOW = "flow"


@dataclass(frozen=True, slots=True)
class RoleDefinition:
    """Compatibility metadata for one stable reservoir role."""

    key: ReservoirRole
    domains: frozenset[str]
    device_classes: frozenset[str]
    source_units: frozenset[str]
    canonical_unit: str | None
    name_hints: tuple[str, ...]


ROLE_DEFINITIONS: dict[ReservoirRole, RoleDefinition] = {
    ReservoirRole.LEVEL_PERCENTAGE: RoleDefinition(
        key=ReservoirRole.LEVEL_PERCENTAGE,
        domains=frozenset({"sensor"}),
        device_classes=frozenset(),
        source_units=frozenset({"%"}),
        canonical_unit="%",
        name_hints=("level", "tank", "percent"),
    ),
    ReservoirRole.LIQUID_DEPTH: RoleDefinition(
        key=ReservoirRole.LIQUID_DEPTH,
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"distance"}),
        source_units=frozenset({"cm", "m", "mm", "in"}),
        canonical_unit="cm",
        name_hints=("depth", "level", "tank"),
    ),
    ReservoirRole.DISTANCE_TO_LIQUID: RoleDefinition(
        key=ReservoirRole.DISTANCE_TO_LIQUID,
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"distance"}),
        source_units=frozenset({"cm", "m", "mm", "in"}),
        canonical_unit="cm",
        name_hints=("distance", "ultrasonic", "gap"),
    ),
    ReservoirRole.WEIGHT: RoleDefinition(
        key=ReservoirRole.WEIGHT,
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"weight"}),
        source_units=frozenset({"kg", "g", "lb"}),
        canonical_unit="kg",
        name_hints=("weight", "load", "scale"),
    ),
    ReservoirRole.WATER_TEMPERATURE: RoleDefinition(
        key=ReservoirRole.WATER_TEMPERATURE,
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"temperature"}),
        source_units=frozenset({"°C", "°F", "K"}),
        canonical_unit="°C",
        name_hints=("water", "reservoir", "temperature"),
    ),
    ReservoirRole.LOW_LEVEL: RoleDefinition(
        key=ReservoirRole.LOW_LEVEL,
        domains=frozenset({"binary_sensor"}),
        device_classes=frozenset(),
        source_units=frozenset(),
        canonical_unit=None,
        name_hints=("low", "level"),
    ),
    ReservoirRole.EMPTY: RoleDefinition(
        key=ReservoirRole.EMPTY,
        domains=frozenset({"binary_sensor"}),
        device_classes=frozenset(),
        source_units=frozenset(),
        canonical_unit=None,
        name_hints=("empty",),
    ),
    ReservoirRole.HIGH_LEVEL: RoleDefinition(
        key=ReservoirRole.HIGH_LEVEL,
        domains=frozenset({"binary_sensor"}),
        device_classes=frozenset(),
        source_units=frozenset(),
        canonical_unit=None,
        name_hints=("high", "level"),
    ),
    ReservoirRole.OVERFLOW: RoleDefinition(
        key=ReservoirRole.OVERFLOW,
        domains=frozenset({"binary_sensor"}),
        device_classes=frozenset(),
        source_units=frozenset(),
        canonical_unit=None,
        name_hints=("overflow",),
    ),
    ReservoirRole.LEAK: RoleDefinition(
        key=ReservoirRole.LEAK,
        domains=frozenset({"binary_sensor"}),
        device_classes=frozenset({"moisture"}),
        source_units=frozenset(),
        canonical_unit=None,
        name_hints=("leak", "moisture", "water"),
    ),
    ReservoirRole.PUMP: RoleDefinition(
        key=ReservoirRole.PUMP,
        domains=frozenset({"switch"}),
        device_classes=frozenset(),
        source_units=frozenset(),
        canonical_unit=None,
        name_hints=("pump",),
    ),
    ReservoirRole.FILL_VALVE: RoleDefinition(
        key=ReservoirRole.FILL_VALVE,
        domains=frozenset({"switch", "valve"}),
        device_classes=frozenset(),
        source_units=frozenset(),
        canonical_unit=None,
        name_hints=("valve", "fill", "top off", "top-off"),
    ),
    ReservoirRole.FLOW: RoleDefinition(
        key=ReservoirRole.FLOW,
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"volume_flow_rate"}),
        source_units=frozenset({"L/min", "gal/min"}),
        canonical_unit="L/min",
        name_hints=("flow", "rate"),
    ),
}


def get_role_definition(role: ReservoirRole | str) -> RoleDefinition:
    """Return one role definition or reject unsupported reservoir roles."""
    try:
        key = role if isinstance(role, ReservoirRole) else ReservoirRole(role)
    except ValueError as exc:
        raise ValueError(f"Unsupported reservoir role: {role}") from exc
    return ROLE_DEFINITIONS[key]
