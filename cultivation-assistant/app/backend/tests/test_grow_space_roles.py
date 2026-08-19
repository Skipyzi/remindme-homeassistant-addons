# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
# pyright: reportUnknownArgumentType=false, reportUntypedBaseClass=false
import pytest
from cultivation_assistant.grow_spaces.roles import (
    EnvironmentalRole,
    get_role_definition,
)


def test_air_temperature_registry_accepts_celsius_and_fahrenheit() -> None:
    definition = get_role_definition(EnvironmentalRole.AIR_TEMPERATURE)

    assert definition.category == "environmental"
    assert definition.canonical_unit == "°C"
    assert definition.device_classes == frozenset({"temperature"})
    assert definition.source_units >= frozenset({"°C", "°F"})


def test_environmental_registry_contains_every_first_slice_role() -> None:
    expected = {
        "air_temperature",
        "canopy_temperature",
        "root_zone_temperature",
        "relative_humidity",
        "co2",
        "illuminance",
        "ppfd",
        "water_temperature",
        "external_vpd",
        "power",
        "energy",
        "leak_detection",
    }

    assert {role.value for role in EnvironmentalRole} == expected


def test_unknown_role_is_rejected() -> None:
    with pytest.raises(ValueError, match="Unsupported semantic role"):
        get_role_definition("grow_light")
