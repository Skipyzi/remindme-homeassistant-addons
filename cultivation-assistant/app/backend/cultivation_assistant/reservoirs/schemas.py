"""Validated HTTP and application contracts for the reservoirs slice."""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cultivation_assistant.grow_spaces.dimensions import DimensionUnit
from cultivation_assistant.reservoirs.geometry import GeometryShape
from cultivation_assistant.reservoirs.roles import get_role_definition
from cultivation_assistant.reservoirs.units import Compatibility

_MIN_CALIBRATION_POINTS = 2

# Default freshness thresholds (seconds) applied when a mapping omits one.
_DEFAULT_SENSOR_STALE_AFTER_SECONDS = 300
_DEFAULT_BINARY_STALE_AFTER_SECONDS = 60


def _default_stale_after_seconds(role: str) -> int:
    """Pick a sensible staleness default for a reservoir role."""
    definition = get_role_definition(role)
    if definition.canonical_unit is None:
        return _DEFAULT_BINARY_STALE_AFTER_SECONDS
    return _DEFAULT_SENSOR_STALE_AFTER_SECONDS


class ReservoirType(StrEnum):
    """Supported physical reservoir categories."""

    AUTOPOT_RESERVOIR = "autopot_reservoir"
    DWC_BUCKET = "dwc_bucket"
    RDWC_CONTROL_RESERVOIR = "rdwc_control_reservoir"
    IRRIGATION_SUPPLY_TANK = "irrigation_supply_tank"
    MIXING_TANK = "mixing_tank"
    TOP_OFF_TANK = "top_off_tank"
    RO_SOURCE_WATER_TANK = "ro_source_water_tank"
    RUNOFF_WASTE_TANK = "runoff_waste_tank"
    CUSTOM_RESERVOIR = "custom_reservoir"


class GeometryInput(BaseModel):
    """Tank geometry for one of the supported shapes."""

    shape: GeometryShape
    unit: DimensionUnit | None = None
    length: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=4)
    width: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=4)
    height: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=4)
    diameter: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=4)

    @model_validator(mode="after")
    def validate_required_fields(self) -> Self:
        if self.shape is GeometryShape.CUSTOM_CALIBRATION_TABLE:
            return self
        if self.unit is None:
            raise ValueError("A unit is required for this geometry shape")
        if self.shape is GeometryShape.RECTANGULAR and (
            self.length is None or self.width is None or self.height is None
        ):
            raise ValueError("Rectangular geometry requires length, width, and height")
        if self.shape is GeometryShape.VERTICAL_CYLINDER and (
            self.diameter is None or self.height is None
        ):
            raise ValueError("Vertical cylinder geometry requires diameter and height")
        if self.shape is GeometryShape.HORIZONTAL_CYLINDER and (
            self.diameter is None or self.length is None
        ):
            raise ValueError("Horizontal cylinder geometry requires diameter and length")
        return self


class GeometryResponse(BaseModel):
    """Editable geometry reconstructed in its stored display unit."""

    shape: GeometryShape
    unit: DimensionUnit | None
    length: Decimal | None
    width: Decimal | None
    height: Decimal | None
    diameter: Decimal | None


class ReservoirCreate(BaseModel):
    """Create one reservoir with its geometry."""

    name: str = Field(min_length=1, max_length=160)
    reservoir_type: ReservoirType
    primary_grow_space_id: str | None = None
    capacity_liters: Decimal = Field(gt=0, max_digits=12, decimal_places=4)
    usable_capacity_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    minimum_safe_volume_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    refill_threshold_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    overflow_threshold_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    geometry: GeometryInput

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Reservoir name is required")
        return cleaned

    @model_validator(mode="after")
    def validate_usable_capacity(self) -> Self:
        if (
            self.usable_capacity_liters is not None
            and self.usable_capacity_liters > self.capacity_liters
        ):
            raise ValueError("Usable capacity cannot exceed capacity")
        return self


class ReservoirUpdate(BaseModel):
    """Patch mutable reservoir fields."""

    name: str | None = Field(default=None, min_length=1, max_length=160)
    reservoir_type: ReservoirType | None = None
    primary_grow_space_id: str | None = None
    capacity_liters: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=4)
    usable_capacity_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    minimum_safe_volume_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    refill_threshold_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    overflow_threshold_liters: Decimal | None = Field(
        default=None, gt=0, max_digits=12, decimal_places=4
    )
    geometry: GeometryInput | None = None
    active: bool | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Reservoir name cannot be blank")
        return cleaned


class LiveReading(BaseModel):
    """Ephemeral normalized value derived from the Home Assistant cache."""

    entity_id: str
    role: str
    raw_value: str
    normalized_value: Decimal | bool | None
    normalized_unit: str | None
    last_updated: datetime
    stale: bool
    available: bool


class ReservoirSummary(BaseModel):
    """Compact reservoir list representation."""

    id: str
    name: str
    reservoir_type: ReservoirType
    primary_grow_space_id: str | None
    capacity_liters: Decimal
    usable_capacity_liters: Decimal | None
    active: bool
    geometry: GeometryResponse
    mapping_count: int = 0
    live_readings: list[LiveReading] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


class ReservoirMappingResponse(BaseModel):
    """Persisted reservoir mapping metadata with live-cache compatibility overlay."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    reservoir_id: str
    entity_id: str
    role: str
    display_name: str | None
    priority: int
    source_unit: str | None
    normalized_unit: str | None
    enabled: bool
    calibration: dict[str, Any] | None
    stale_after_seconds: int
    compatibility: Compatibility = Compatibility.UNKNOWN
    compatibility_explanation: str = "Entity is not currently present in the state cache."
    created_at: datetime
    updated_at: datetime


class ReservoirResponse(ReservoirSummary):
    """Detailed reservoir representation."""

    minimum_safe_volume_liters: Decimal | None
    refill_threshold_liters: Decimal | None
    overflow_threshold_liters: Decimal | None
    mappings: list[ReservoirMappingResponse] = Field(default_factory=list)


class ReservoirListResponse(BaseModel):
    """Stable list envelope for reservoirs."""

    items: list[ReservoirSummary]


class EntityCandidate(BaseModel):
    """One role-compatible Home Assistant entity suggestion."""

    entity_id: str
    friendly_name: str
    domain: str
    device_class: str | None
    source_unit: str | None
    current_state: str
    last_updated: datetime
    available: bool
    compatibility: Compatibility
    explanation: str


class EntityDiscoveryResponse(BaseModel):
    """Stable envelope for role-filtered reservoir entity suggestions."""

    items: list[EntityCandidate] = Field(default_factory=list)


class ReservoirMappingCreate(BaseModel):
    """Create one semantic mapping for a reservoir HA entity."""

    entity_id: str = Field(
        min_length=3,
        max_length=255,
        pattern=r"^[a-z0-9_]+\.[a-z0-9_]+$",
    )
    role: str
    display_name: str | None = Field(default=None, max_length=160)
    priority: int = Field(default=100, ge=0, le=10000)
    enabled: bool = True
    calibration: dict[str, Any] | None = None
    stale_after_seconds: int | None = Field(default=None, ge=30, le=86400)

    @field_validator("role")
    @classmethod
    def validate_role(cls, value: str) -> str:
        return get_role_definition(value).key.value

    @field_validator("display_name")
    @classmethod
    def clean_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def apply_stale_default(self) -> Self:
        if self.stale_after_seconds is None:
            self.stale_after_seconds = _default_stale_after_seconds(self.role)
        return self


class ReservoirMappingUpdate(BaseModel):
    """Mutable reservoir mapping fields; entity and role identity remain stable."""

    display_name: str | None = Field(default=None, max_length=160)
    priority: int | None = Field(default=None, ge=0, le=10000)
    enabled: bool | None = None
    calibration: dict[str, Any] | None = None
    stale_after_seconds: int | None = Field(default=None, ge=30, le=86400)

    @field_validator("display_name")
    @classmethod
    def clean_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class CalibrationPointInput(BaseModel):
    """One raw-reading-to-volume calibration point."""

    raw_value: Decimal = Field(max_digits=12, decimal_places=4)
    volume_liters: Decimal = Field(ge=0, max_digits=12, decimal_places=4)


class CalibrationPointsReplace(BaseModel):
    """Replace a reservoir's entire calibration table."""

    points: list[CalibrationPointInput]

    @model_validator(mode="after")
    def validate_points(self) -> Self:
        if len(self.points) < _MIN_CALIBRATION_POINTS:
            raise ValueError("A calibration table requires at least two points")
        raw_values = [point.raw_value for point in self.points]
        if len(set(raw_values)) != len(raw_values):
            raise ValueError("Calibration points must have distinct raw values")
        return self


class CalibrationPointResponse(BaseModel):
    """Persisted calibration point representation."""

    id: str
    reservoir_id: str
    raw_value: Decimal
    volume_liters: Decimal


class CalibrationPointListResponse(BaseModel):
    """Stable list envelope for calibration points, ordered by raw value."""

    items: list[CalibrationPointResponse]
