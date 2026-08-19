"""Derive reservoir volume from mapped level sensors and reading history.

Selection prefers continuous level roles (percentage, then depth, then
distance) using the role order defined in `geometry.py`; ties break on the
mapping's own priority. Custom-calibration reservoirs interpolate their
calibration table from the best available numeric reading instead.
"""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation

from cultivation_assistant.db.models import (
    Reservoir,
    ReservoirCalibrationPoint,
    ReservoirEntityMapping,
)
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.reservoirs.geometry import (
    LEVEL_ROLE_PRIORITY,
    GeometryShape,
    interpolate_calibration,
    volume_from_depth,
    volume_from_percentage,
)
from cultivation_assistant.reservoirs.units import (
    is_binary_reservoir_role,
    normalize_reservoir_value,
)

_CM_TO_M = Decimal("0.01")
_PERCENT_SCALE = Decimal("100")

# Numeric roles (beyond the dedicated level roles) usable as a calibration
# source when no geometric level sensor is mapped.
_FALLBACK_CALIBRATION_ROLES: tuple[str, ...] = ("weight",)


@dataclass(frozen=True, slots=True)
class CurrentVolume:
    """One reservoir's live volume reading with its provenance."""

    volume_liters: Decimal
    level_percent: Decimal | None
    source_entity_id: str
    role: str
    last_updated: datetime
    stale: bool


def _numeric_state(
    state_cache: EntityStateCache,
    mapping: ReservoirEntityMapping,
) -> Decimal | None:
    """Return the normalized numeric reading for a mapping, or None."""
    state = state_cache.find(mapping.entity_id)
    if state is None or state.state.casefold() in {"unknown", "unavailable"}:
        return None
    if is_binary_reservoir_role(mapping.role) or mapping.source_unit is None:
        return None
    try:
        return normalize_reservoir_value(
            mapping.role, Decimal(state.state), mapping.source_unit
        )
    except (InvalidOperation, ValueError):
        return None


def _sorted_candidates(
    mappings: list[ReservoirEntityMapping],
    roles: tuple[str, ...],
) -> list[ReservoirEntityMapping]:
    """Enabled mappings for the given roles, best-first."""
    selected = [m for m in mappings if m.enabled and m.role in roles]
    selected.sort(key=lambda m: (roles.index(m.role), m.priority, m.entity_id))
    return selected


def _geometry_dimensions(record: Reservoir) -> dict[str, Decimal | None] | None:
    """Collect the stored geometry dimensions in metres, when complete."""
    if record.geometry_shape is GeometryShape.CUSTOM_CALIBRATION_TABLE.value:
        return None
    dimensions: dict[str, Decimal | None] = {
        "length_m": record.geometry_length_m,
        "width_m": record.geometry_width_m,
        "height_m": record.geometry_height_m,
        "diameter_m": record.geometry_diameter_m,
    }
    required = {
        GeometryShape.RECTANGULAR.value: ("length_m", "width_m", "height_m"),
        GeometryShape.VERTICAL_CYLINDER.value: ("diameter_m", "height_m"),
        GeometryShape.HORIZONTAL_CYLINDER.value: ("diameter_m", "length_m"),
    }.get(record.geometry_shape, ())
    if any(dimensions[key] is None for key in required):
        return None
    return dimensions


def _clamped(value: Decimal, maximum: Decimal) -> Decimal:
    return max(Decimal("0"), min(value, maximum))


def _level_percent(volume: Decimal, reference: Decimal) -> Decimal:
    if reference <= 0:
        return Decimal("0")
    return _clamped(volume / reference * _PERCENT_SCALE, _PERCENT_SCALE)


def select_level_source(
    mappings: list[ReservoirEntityMapping],
) -> ReservoirEntityMapping | None:
    """Pick the preferred enabled mapping for live level tracking."""
    candidates = _sorted_candidates(mappings, LEVEL_ROLE_PRIORITY)
    return candidates[0] if candidates else None


def compute_volume(
    record: Reservoir,
    mappings: list[ReservoirEntityMapping],
    calibration_points: list[ReservoirCalibrationPoint],
    state_cache: EntityStateCache,
) -> CurrentVolume | None:
    """Compute the live volume of one reservoir from its mapped sensors."""
    usable = record.usable_capacity_liters or record.capacity_liters

    def build(
        volume: Decimal,
        mapping: ReservoirEntityMapping,
        state_last_updated: datetime,
        stale: bool,
        percent: Decimal | None = None,
    ) -> CurrentVolume:
        clamped = _clamped(volume, record.capacity_liters)
        return CurrentVolume(
            volume_liters=clamped,
            level_percent=percent if percent is not None else _level_percent(clamped, usable),
            source_entity_id=mapping.entity_id,
            role=mapping.role,
            last_updated=state_last_updated,
            stale=stale,
        )

    for mapping in _sorted_candidates(mappings, LEVEL_ROLE_PRIORITY):
        value = _numeric_state(state_cache, mapping)
        if value is None:
            continue
        state = state_cache.find(mapping.entity_id)
        assert state is not None
        stale = state_cache.is_stale(
            mapping.entity_id, timedelta(seconds=mapping.stale_after_seconds)
        )

        if mapping.role == "level_percentage":
            volume = volume_from_percentage(usable, value / _PERCENT_SCALE)
            return build(volume, mapping, state.last_updated, stale)

        dimensions = _geometry_dimensions(record)
        if dimensions is None:
            continue
        strict_dimensions = {
            key: value for key, value in dimensions.items() if value is not None
        }

        if mapping.role == "liquid_depth":
            height = dimensions.get("height_m")
            depth_m = (
                _clamped(value * _CM_TO_M, height)
                if height is not None
                else value * _CM_TO_M
            )
            volume = volume_from_depth(
                GeometryShape(record.geometry_shape), strict_dimensions, depth_m
            )
            return build(volume, mapping, state.last_updated, stale)

        if mapping.role == "distance_to_liquid":
            height_m = dimensions.get("height_m")
            if height_m is None or height_m <= 0:
                continue
            depth_m = _clamped(height_m - value * _CM_TO_M, height_m)
            volume = volume_from_depth(
                GeometryShape(record.geometry_shape), strict_dimensions, depth_m
            )
            return build(volume, mapping, state.last_updated, stale)

    # Calibration fallback: custom-calibration tanks (or tanks whose level
    # role could not produce geometry) interpolate their table from the best
    # numeric mapping available.
    if len(calibration_points) >= 2:
        numeric_roles = LEVEL_ROLE_PRIORITY + _FALLBACK_CALIBRATION_ROLES
        for mapping in _sorted_candidates(mappings, numeric_roles):
            value = _numeric_state(state_cache, mapping)
            if value is None:
                continue
            state = state_cache.find(mapping.entity_id)
            assert state is not None
            stale = state_cache.is_stale(
                mapping.entity_id, timedelta(seconds=mapping.stale_after_seconds)
            )
            volume = interpolate_calibration(
                [(point.raw_value, point.volume_liters) for point in calibration_points],
                value,
            )
            return build(volume, mapping, state.last_updated, stale)

    return None


def as_utc(value: datetime) -> datetime:
    """Reattach UTC to naive datetimes read back from SQLite storage."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


@dataclass(frozen=True, slots=True)
class ConsumptionSummary:
    """Decrease-only consumption over the recorded reading history."""

    daily_liters: Decimal | None
    seven_day_average_liters: Decimal | None
    reading_count_24h: int
    history_days: float


def consumption_from_readings(
    readings: list[tuple[datetime, Decimal]],
    *,
    now: datetime,
) -> ConsumptionSummary | None:
    """Sum volume decreases over time; increases are refills and are excluded.

    This is an approximation until refill events are recorded explicitly.
    """
    if not readings:
        return None
    ordered = sorted(
        ((as_utc(at), volume) for at, volume in readings), key=lambda item: item[0]
    )
    day_ago = now - timedelta(hours=24)
    week_ago = now - timedelta(days=7)

    daily_total = Decimal("0")
    daily_count = 0
    week_total = Decimal("0")
    for (_previous_at, previous_volume), (at, volume) in zip(
        ordered, ordered[1:], strict=False
    ):
        decrease = previous_volume - volume
        if decrease <= 0:
            continue
        if at > day_ago:
            daily_total += decrease
            daily_count += 1
        if at > week_ago:
            week_total += decrease

    span = (ordered[-1][0] - ordered[0][0]).total_seconds() / 86400
    seven_day_average = None
    if span >= 1.0:
        days = min(Decimal("7"), Decimal(str(span)))
        seven_day_average = (week_total / days).quantize(Decimal("0.0001"))

    return ConsumptionSummary(
        daily_liters=daily_total.quantize(Decimal("0.0001")),
        seven_day_average_liters=seven_day_average,
        reading_count_24h=daily_count + (1 if ordered[-1][0] > day_ago else 0),
        history_days=span,
    )


@dataclass(frozen=True, slots=True)
class RefillForecast:
    """Estimated time until the reservoir reaches its refill threshold."""

    remaining_until_refill_liters: Decimal
    hours_remaining: Decimal | None
    estimated_refill_at: datetime | None


def refill_forecast(
    current_volume: Decimal,
    refill_threshold: Decimal | None,
    daily_consumption: Decimal | None,
    *,
    now: datetime | None = None,
) -> RefillForecast | None:
    """Project when the volume falls to the threshold, from daily consumption.

    Returns None when no threshold or no positive consumption is known — the
    caller surfaces missing inputs rather than inventing a date.
    """
    if refill_threshold is None:
        return None
    remaining = current_volume - refill_threshold
    if remaining <= 0:
        return RefillForecast(remaining, Decimal("0"), now or datetime.now(UTC))
    if daily_consumption is None or daily_consumption <= 0:
        return RefillForecast(remaining, None, None)
    reference = now or datetime.now(UTC)
    hours = (remaining / daily_consumption * Decimal("24")).quantize(Decimal("0.01"))
    return RefillForecast(
        remaining,
        hours,
        reference + timedelta(hours=float(hours)),
    )
