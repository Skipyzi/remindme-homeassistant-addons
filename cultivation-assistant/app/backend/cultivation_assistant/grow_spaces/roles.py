"""Semantic role definitions for grow-space entity mappings."""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal


class EnvironmentalRole(StrEnum):
    """Environmental Home Assistant roles supported by the first vertical slice."""

    AIR_TEMPERATURE = "air_temperature"
    CANOPY_TEMPERATURE = "canopy_temperature"
    ROOT_ZONE_TEMPERATURE = "root_zone_temperature"
    RELATIVE_HUMIDITY = "relative_humidity"
    CO2 = "co2"
    ILLUMINANCE = "illuminance"
    PPFD = "ppfd"
    WATER_TEMPERATURE = "water_temperature"
    EXTERNAL_VPD = "external_vpd"
    POWER = "power"
    ENERGY = "energy"
    LEAK_DETECTION = "leak_detection"


@dataclass(frozen=True, slots=True)
class RoleDefinition:
    """Compatibility metadata for one stable semantic role."""

    key: EnvironmentalRole
    category: Literal["environmental"]
    domains: frozenset[str]
    device_classes: frozenset[str]
    source_units: frozenset[str]
    canonical_unit: str | None
    default_stale_after_seconds: int
    name_hints: tuple[str, ...]


def _temperature_role(
    key: EnvironmentalRole,
    *name_hints: str,
) -> RoleDefinition:
    return RoleDefinition(
        key=key,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"temperature"}),
        source_units=frozenset({"°C", "°F", "K"}),
        canonical_unit="°C",
        default_stale_after_seconds=300,
        name_hints=name_hints,
    )


ROLE_DEFINITIONS: dict[EnvironmentalRole, RoleDefinition] = {
    EnvironmentalRole.AIR_TEMPERATURE: _temperature_role(
        EnvironmentalRole.AIR_TEMPERATURE, "air", "ambient", "room", "temperature"
    ),
    EnvironmentalRole.CANOPY_TEMPERATURE: _temperature_role(
        EnvironmentalRole.CANOPY_TEMPERATURE, "canopy", "leaf", "temperature"
    ),
    EnvironmentalRole.ROOT_ZONE_TEMPERATURE: _temperature_role(
        EnvironmentalRole.ROOT_ZONE_TEMPERATURE, "root", "soil", "medium", "temperature"
    ),
    EnvironmentalRole.RELATIVE_HUMIDITY: RoleDefinition(
        key=EnvironmentalRole.RELATIVE_HUMIDITY,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"humidity"}),
        source_units=frozenset({"%"}),
        canonical_unit="%",
        default_stale_after_seconds=300,
        name_hints=("humidity", "rh"),
    ),
    EnvironmentalRole.CO2: RoleDefinition(
        key=EnvironmentalRole.CO2,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"carbon_dioxide"}),
        source_units=frozenset({"ppm"}),
        canonical_unit="ppm",
        default_stale_after_seconds=300,
        name_hints=("co2", "carbon dioxide"),
    ),
    EnvironmentalRole.ILLUMINANCE: RoleDefinition(
        key=EnvironmentalRole.ILLUMINANCE,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"illuminance"}),
        source_units=frozenset({"lx"}),
        canonical_unit="lx",
        default_stale_after_seconds=300,
        name_hints=("illuminance", "lux", "light"),
    ),
    EnvironmentalRole.PPFD: RoleDefinition(
        key=EnvironmentalRole.PPFD,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset(),
        source_units=frozenset({"µmol/m²/s"}),
        canonical_unit="µmol/m²/s",
        default_stale_after_seconds=300,
        name_hints=("ppfd", "par", "photon flux"),
    ),
    EnvironmentalRole.WATER_TEMPERATURE: _temperature_role(
        EnvironmentalRole.WATER_TEMPERATURE, "water", "reservoir", "solution", "temperature"
    ),
    EnvironmentalRole.EXTERNAL_VPD: RoleDefinition(
        key=EnvironmentalRole.EXTERNAL_VPD,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"pressure"}),
        source_units=frozenset({"kPa", "Pa", "hPa"}),
        canonical_unit="kPa",
        default_stale_after_seconds=300,
        name_hints=("vpd", "vapour pressure deficit", "vapor pressure deficit"),
    ),
    EnvironmentalRole.POWER: RoleDefinition(
        key=EnvironmentalRole.POWER,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"power"}),
        source_units=frozenset({"W", "kW"}),
        canonical_unit="W",
        default_stale_after_seconds=120,
        name_hints=("power", "watt"),
    ),
    EnvironmentalRole.ENERGY: RoleDefinition(
        key=EnvironmentalRole.ENERGY,
        category="environmental",
        domains=frozenset({"sensor"}),
        device_classes=frozenset({"energy"}),
        source_units=frozenset({"Wh", "kWh"}),
        canonical_unit="kWh",
        default_stale_after_seconds=3600,
        name_hints=("energy", "consumption"),
    ),
    EnvironmentalRole.LEAK_DETECTION: RoleDefinition(
        key=EnvironmentalRole.LEAK_DETECTION,
        category="environmental",
        domains=frozenset({"binary_sensor"}),
        device_classes=frozenset({"moisture"}),
        source_units=frozenset(),
        canonical_unit=None,
        default_stale_after_seconds=60,
        name_hints=("leak", "moisture", "water"),
    ),
}


def get_role_definition(role: EnvironmentalRole | str) -> RoleDefinition:
    """Return one role definition or reject unsupported semantic roles."""
    try:
        key = role if isinstance(role, EnvironmentalRole) else EnvironmentalRole(role)
    except ValueError as exc:
        raise ValueError(f"Unsupported semantic role: {role}") from exc
    return ROLE_DEFINITIONS[key]
