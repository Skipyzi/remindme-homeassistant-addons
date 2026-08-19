from decimal import Decimal

from cultivation_assistant.reservoirs.geometry import (
    GeometryShape,
    interpolate_calibration,
    volume_from_depth,
    volume_from_percentage,
)


def test_rectangular_volume_from_depth() -> None:
    volume = volume_from_depth(
        GeometryShape.RECTANGULAR,
        {"length_m": Decimal("0.5"), "width_m": Decimal("0.4"), "height_m": Decimal("0.6")},
        depth_m=Decimal("0.3"),
    )
    assert volume == Decimal("60.0000")


def test_vertical_cylinder_volume_from_depth() -> None:
    volume = volume_from_depth(
        GeometryShape.VERTICAL_CYLINDER,
        {"diameter_m": Decimal("0.5"), "height_m": Decimal("1.0")},
        depth_m=Decimal("0.5"),
    )
    # pi * (0.25)^2 * 0.5 * 1000 ~= 98.17
    assert Decimal("98.0") < volume < Decimal("99.0")


def test_horizontal_cylinder_full_matches_vertical_cylinder_full() -> None:
    horizontal = volume_from_depth(
        GeometryShape.HORIZONTAL_CYLINDER,
        {"diameter_m": Decimal("0.5"), "length_m": Decimal("1.0")},
        depth_m=Decimal("0.5"),
    )
    vertical = volume_from_depth(
        GeometryShape.VERTICAL_CYLINDER,
        {"diameter_m": Decimal("0.5"), "height_m": Decimal("1.0")},
        depth_m=Decimal("1.0"),
    )
    assert abs(horizontal - vertical) < Decimal("0.5")


def test_horizontal_cylinder_half_full_is_half_of_full_volume() -> None:
    half = volume_from_depth(
        GeometryShape.HORIZONTAL_CYLINDER,
        {"diameter_m": Decimal("0.5"), "length_m": Decimal("1.0")},
        depth_m=Decimal("0.25"),
    )
    full = volume_from_depth(
        GeometryShape.HORIZONTAL_CYLINDER,
        {"diameter_m": Decimal("0.5"), "length_m": Decimal("1.0")},
        depth_m=Decimal("0.5"),
    )
    assert abs(half - full / 2) < Decimal("0.1")


def test_percentage_volume_uses_usable_capacity() -> None:
    assert volume_from_percentage(Decimal("100"), Decimal("0.5")) == Decimal("50")


def test_calibration_interpolates_between_points_and_clamps() -> None:
    points = [
        (Decimal("0"), Decimal("0")),
        (Decimal("50"), Decimal("100")),
        (Decimal("100"), Decimal("200")),
    ]
    assert interpolate_calibration(points, Decimal("25")) == Decimal("50")
    assert interpolate_calibration(points, Decimal("150")) == Decimal("200")
    assert interpolate_calibration(points, Decimal("-10")) == Decimal("0")


def test_calibration_handles_unsorted_input() -> None:
    points = [
        (Decimal("100"), Decimal("200")),
        (Decimal("0"), Decimal("0")),
    ]
    assert interpolate_calibration(points, Decimal("50")) == Decimal("100")
