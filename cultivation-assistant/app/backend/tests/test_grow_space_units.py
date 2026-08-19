# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
from decimal import Decimal

from cultivation_assistant.grow_spaces.units import (
    Compatibility,
    classify_unit,
    normalize_area,
    normalize_environment_value,
    normalize_volume,
)


def test_fahrenheit_is_convertible_and_normalized_to_celsius() -> None:
    result = classify_unit("air_temperature", "°F")

    assert result.compatibility is Compatibility.CONVERTIBLE
    assert result.normalized_unit == "°C"
    assert normalize_environment_value("air_temperature", Decimal("77"), "°F") == Decimal("25")


def test_dimensions_are_normalized_to_si() -> None:
    assert normalize_area(Decimal("16"), "ft²").quantize(Decimal("0.0001")) == Decimal("1.4864")
    assert normalize_volume(Decimal("100"), "ft³").quantize(Decimal("0.0001")) == Decimal("2.8317")


def test_known_incompatible_unit_is_classified() -> None:
    result = classify_unit("relative_humidity", "ppm")

    assert result.compatibility is Compatibility.INCOMPATIBLE


def test_missing_source_unit_is_unknown() -> None:
    result = classify_unit("external_vpd", None)

    assert result.compatibility is Compatibility.UNKNOWN
    assert result.normalized_unit == "kPa"
