"""Validated HTTP and application contracts for grow spaces."""

from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cultivation_assistant.grow_spaces.dimensions import DimensionUnit
from cultivation_assistant.grow_spaces.roles import get_role_definition
from cultivation_assistant.grow_spaces.units import Compatibility


class GrowSpaceType(StrEnum):
    """Supported physical grow-space categories."""

    TENT = "tent"
    GREENHOUSE = "greenhouse"
    OUTDOOR = "outdoor"
    ROOM = "room"


class DimensionsInput(BaseModel):
    """Positive linear dimensions in one shared display unit."""

    length: Decimal = Field(gt=0, max_digits=12, decimal_places=4)
    width: Decimal = Field(gt=0, max_digits=12, decimal_places=4)
    height: Decimal | None = Field(default=None, gt=0, max_digits=12, decimal_places=4)
    unit: DimensionUnit


class DimensionsResponse(BaseModel):
    """Editable dimensions reconstructed in their preferred unit."""

    length: Decimal
    width: Decimal
    height: Decimal | None
    unit: DimensionUnit


class EntityMappingCreate(BaseModel):
    """Create one semantic mapping for an existing or manual HA entity ID."""

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
            self.stale_after_seconds = get_role_definition(self.role).default_stale_after_seconds
        return self


class EntityMappingUpdate(BaseModel):
    """Mutable mapping fields; entity and role identity remain stable."""

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


def _empty_entity_mappings() -> list[EntityMappingCreate]:
    return []


class GrowSpaceCreate(BaseModel):
    """Create a universal grow space and optional initial mappings."""

    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    location: str | None = Field(default=None, max_length=200)
    space_type: GrowSpaceType
    dimensions: DimensionsInput
    mappings: list[EntityMappingCreate] = Field(default_factory=_empty_entity_mappings)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Grow-space name is required")
        return cleaned

    @field_validator("description", "location")
    @classmethod
    def clean_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def require_enclosed_height(self) -> Self:
        if self.space_type is not GrowSpaceType.OUTDOOR and self.dimensions.height is None:
            raise ValueError("Height is required for enclosed grow spaces")
        return self


class GrowSpaceUpdate(BaseModel):
    """Patch mutable core grow-space fields."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    location: str | None = Field(default=None, max_length=200)
    space_type: GrowSpaceType | None = None
    dimensions: DimensionsInput | None = None
    active: bool | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Grow-space name cannot be blank")
        return cleaned

    @field_validator("description", "location")
    @classmethod
    def clean_optional_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


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


class EntityMappingResponse(BaseModel):
    """Persisted semantic mapping metadata."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    grow_space_id: str
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


def _empty_live_readings() -> list[LiveReading]:
    return []


class GrowSpaceSummary(BaseModel):
    """Compact grow-space list representation."""

    id: str
    name: str
    description: str | None
    location: str | None
    space_type: str
    active: bool
    dimensions: DimensionsResponse | None
    area_m2: Decimal | None
    volume_m3: Decimal | None
    mapping_count: int
    live_readings: list[LiveReading] = Field(default_factory=_empty_live_readings)
    created_at: datetime
    updated_at: datetime


class GrowSpaceResponse(GrowSpaceSummary):
    """Detailed grow-space representation with all mappings."""

    mappings: list[EntityMappingResponse]


class GrowSpaceListResponse(BaseModel):
    """Stable list envelope for grow spaces."""

    items: list[GrowSpaceSummary]


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


def _empty_entity_candidates() -> list[EntityCandidate]:
    return []


class EntityDiscoveryResponse(BaseModel):
    """Stable envelope for role-filtered entity suggestions."""

    items: list[EntityCandidate] = Field(default_factory=_empty_entity_candidates)
