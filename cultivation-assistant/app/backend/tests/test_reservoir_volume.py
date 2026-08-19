# pyright: reportMissingImports=false
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from cultivation_assistant.db.models import (
    Reservoir,
    ReservoirCalibrationPoint,
    ReservoirEntityMapping,
)
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.reservoirs.volume import (
    compute_volume,
    consumption_from_readings,
    refill_forecast,
    select_level_source,
)


def cached_state(entity_id: str, value: str, unit: str | None) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": value,
        "last_updated": datetime.now(UTC).isoformat(),
        "attributes": {
            "unit_of_measurement": unit,
            "device_class": None,
            "friendly_name": entity_id,
        },
    }


def rectangular_reservoir(**overrides: Any) -> Reservoir:
    # 50cm x 40cm x 60cm tank = 120 L full capacity.
    fields: dict[str, Any] = {
        "name": "Mixing tank",
        "reservoir_type": "mixing_tank",
        "capacity_liters": Decimal("120"),
        "usable_capacity_liters": None,
        "geometry_shape": "rectangular",
        "geometry_unit": "cm",
        "geometry_length_m": Decimal("0.5"),
        "geometry_width_m": Decimal("0.4"),
        "geometry_height_m": Decimal("0.6"),
    }
    fields.update(overrides)
    return Reservoir(**fields)


def mapping(
    entity_id: str,
    role: str,
    *,
    source_unit: str | None,
    priority: int = 100,
    enabled: bool = True,
) -> ReservoirEntityMapping:
    return ReservoirEntityMapping(
        reservoir_id="res-1",
        entity_id=entity_id,
        role=role,
        priority=priority,
        enabled=enabled,
        source_unit=source_unit,
        stale_after_seconds=300,
    )


def test_select_level_source_prefers_percentage_then_priority() -> None:
    selected = select_level_source(
        [
            mapping("sensor.depth", "liquid_depth", source_unit="cm", priority=1),
            mapping("sensor.pct_b", "level_percentage", source_unit="%", priority=50),
            mapping("sensor.pct_a", "level_percentage", source_unit="%", priority=10),
            mapping("sensor.disabled", "level_percentage", source_unit="%", enabled=False),
        ]
    )
    assert selected is not None
    assert selected.entity_id == "sensor.pct_a"


def test_compute_volume_from_percentage_of_usable_capacity() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.tank_level", "50", "%"))
    reservoir = rectangular_reservoir(usable_capacity_liters=Decimal("100"))

    current = compute_volume(
        reservoir,
        [mapping("sensor.tank_level", "level_percentage", source_unit="%")],
        [],
        cache,
    )

    assert current is not None
    assert current.volume_liters == Decimal("50.0000")
    assert current.level_percent == Decimal("50")
    assert current.role == "level_percentage"


def test_compute_volume_clamps_percentage_above_capacity() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.tank_level", "150", "%"))

    current = compute_volume(
        rectangular_reservoir(),
        [mapping("sensor.tank_level", "level_percentage", source_unit="%")],
        [],
        cache,
    )

    assert current is not None
    assert current.volume_liters == Decimal("120.0000")


def test_compute_volume_from_liquid_depth() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.depth", "30", "cm"))
    # 30cm depth in a 50x40 tank = 0.5 * 0.4 * 0.3 m3 = 60 L.
    current = compute_volume(
        rectangular_reservoir(),
        [mapping("sensor.depth", "liquid_depth", source_unit="cm")],
        [],
        cache,
    )

    assert current is not None
    assert current.volume_liters == Decimal("60.0000")


def test_compute_volume_converts_depth_units() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.depth", "0.3", "m"))

    current = compute_volume(
        rectangular_reservoir(),
        [mapping("sensor.depth", "liquid_depth", source_unit="m")],
        [],
        cache,
    )

    assert current is not None
    assert current.volume_liters == Decimal("60.0000")


def test_compute_volume_from_distance_to_liquid() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.gap", "30", "cm"))
    # Tank is 60cm tall; a 30cm gap means 30cm of water = 60 L.
    current = compute_volume(
        rectangular_reservoir(),
        [mapping("sensor.gap", "distance_to_liquid", source_unit="cm")],
        [],
        cache,
    )

    assert current is not None
    assert current.volume_liters == Decimal("60.0000")


def test_distance_to_liquid_requires_tank_height() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.gap", "30", "cm"))
    reservoir = Reservoir(
        name="Horizontal",
        reservoir_type="mixing_tank",
        capacity_liters=Decimal("70.686"),
        geometry_shape="horizontal_cylinder",
        geometry_unit="cm",
        geometry_diameter_m=Decimal("0.3"),
        geometry_length_m=Decimal("1"),
    )

    current = compute_volume(
        reservoir,
        [mapping("sensor.gap", "distance_to_liquid", source_unit="cm")],
        [],
        cache,
    )

    assert current is None


def test_compute_volume_interpolates_calibration_table() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.load", "12.5", "kg"))
    reservoir = Reservoir(
        name="Calibrated",
        reservoir_type="custom_reservoir",
        capacity_liters=Decimal("200"),
        geometry_shape="custom_calibration_table",
    )
    def calibration(raw: str, volume: str) -> ReservoirCalibrationPoint:
        return ReservoirCalibrationPoint(
            reservoir_id="res-1", raw_value=Decimal(raw), volume_liters=Decimal(volume)
        )

    points = [
        calibration("0", "0"),
        calibration("10", "160"),
        calibration("20", "200"),
    ]

    current = compute_volume(
        reservoir, [mapping("sensor.load", "weight", source_unit="kg")], points, cache
    )

    assert current is not None
    # 12.5 kg interpolates 40% of the way from 160 L (at 10 kg) to 200 L (at 20 kg).
    assert current.volume_liters == Decimal("170.0000")


def test_compute_volume_skips_unavailable_sensors() -> None:
    cache = EntityStateCache()
    cache.update(cached_state("sensor.tank_level", "unavailable", "%"))

    current = compute_volume(
        rectangular_reservoir(),
        [mapping("sensor.tank_level", "level_percentage", source_unit="%")],
        [],
        cache,
    )

    assert current is None


def test_compute_volume_returns_none_without_any_source() -> None:
    current = compute_volume(rectangular_reservoir(), [], [], EntityStateCache())

    assert current is None


def test_consumption_sums_decreases_and_ignores_refills() -> None:
    now = datetime.now(UTC)
    day_ago = now - timedelta(hours=23)
    readings = [
        (day_ago, Decimal("100")),
        (day_ago + timedelta(hours=1), Decimal("90")),  # -10
        (day_ago + timedelta(hours=2), Decimal("120")),  # refill, ignored
        (day_ago + timedelta(hours=3), Decimal("60")),  # -60
        (now, Decimal("55")),  # -5
    ]

    summary = consumption_from_readings(readings, now=now)

    assert summary is not None
    assert summary.daily_liters == Decimal("75.0000")
    assert summary.history_days > 0.9


def test_consumption_requires_a_full_day_for_seven_day_average() -> None:
    now = datetime.now(UTC)
    readings = [
        (now - timedelta(hours=2), Decimal("100")),
        (now - timedelta(hours=1), Decimal("90")),
    ]

    summary = consumption_from_readings(readings, now=now)

    assert summary is not None
    assert summary.daily_liters == Decimal("10.0000")
    assert summary.seven_day_average_liters is None


def test_consumption_returns_none_without_readings() -> None:
    assert consumption_from_readings([], now=datetime.now(UTC)) is None


def test_refill_forecast_projects_hours_from_daily_consumption() -> None:
    now = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)
    forecast = refill_forecast(Decimal("80"), Decimal("20"), Decimal("30"), now=now)

    assert forecast is not None
    assert forecast.remaining_until_refill_liters == Decimal("60")
    assert forecast.hours_remaining == Decimal("48.00")
    assert forecast.estimated_refill_at == now + timedelta(hours=48)


def test_refill_forecast_is_due_now_at_or_below_threshold() -> None:
    now = datetime.now(UTC)
    forecast = refill_forecast(Decimal("15"), Decimal("20"), Decimal("30"), now=now)

    assert forecast is not None
    assert forecast.hours_remaining == Decimal("0")
    assert forecast.estimated_refill_at == now


def test_refill_forecast_returns_none_without_threshold_or_consumption() -> None:
    now = datetime.now(UTC)
    assert refill_forecast(Decimal("80"), None, Decimal("30"), now=now) is None
    no_consumption = refill_forecast(Decimal("80"), Decimal("20"), None, now=now)
    assert no_consumption is not None
    assert no_consumption.hours_remaining is None
    assert no_consumption.estimated_refill_at is None
