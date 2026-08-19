from decimal import Decimal

import pytest
from cultivation_assistant.grow_spaces.dimensions import (
    CanonicalDimensions,
    DimensionUnit,
    derive_measurements,
    from_metres,
    to_metres,
)


def test_centimetres_convert_to_canonical_metres() -> None:
    assert to_metres(Decimal("80"), DimensionUnit.CM) == Decimal("0.8000")


def test_inches_round_trip_without_changing_physical_size() -> None:
    metres = to_metres(Decimal("80"), DimensionUnit.IN)

    assert metres == Decimal("2.0320")
    assert from_metres(metres, DimensionUnit.IN) == Decimal("80")


def test_area_and_volume_are_derived_from_canonical_dimensions() -> None:
    dimensions = CanonicalDimensions(
        length_m=Decimal("0.8000"),
        width_m=Decimal("0.8000"),
        height_m=Decimal("1.8000"),
    )

    assert derive_measurements(dimensions) == (
        Decimal("0.6400"),
        Decimal("1.1520"),
    )


def test_outdoor_dimensions_without_height_have_no_volume() -> None:
    dimensions = CanonicalDimensions(
        length_m=Decimal("2.0000"),
        width_m=Decimal("3.0000"),
        height_m=None,
    )

    assert derive_measurements(dimensions) == (Decimal("6.0000"), None)


@pytest.mark.parametrize("value", [Decimal("0"), Decimal("-1")])
def test_non_positive_dimensions_are_rejected(value: Decimal) -> None:
    with pytest.raises(ValueError, match="positive"):
        to_metres(value, DimensionUnit.CM)
