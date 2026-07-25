"""Validated HTTP and application contracts for Plants and transitions."""

from datetime import date, datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cultivation_assistant.lifecycle.rules import (
    PlantStatus,
    PropagationSource,
    SeedType,
    TransitionSource,
)

_STATUS_REQUIRES_START = {
    PlantStatus.ACTIVE,
    PlantStatus.HARVESTED,
    PlantStatus.COMPLETED,
    PlantStatus.LOST,
}
_HARVEST_STATUSES = {PlantStatus.HARVESTED, PlantStatus.COMPLETED}


def _clean_name(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("Plant name is required")
    return cleaned


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


class PlantCreate(BaseModel):
    """Create one individually identifiable Plant with an initial stage."""

    grow_id: str
    cultivar_id: str
    name: str = Field(min_length=1, max_length=120)
    propagation_source: PropagationSource
    seed_type: SeedType | None = None
    start_date: date | None = None
    current_stage_id: str
    status: PlantStatus = PlantStatus.PLANNED
    container: str | None = None
    medium: str | None = None
    location: str | None = None
    expected_harvest_start: date | None = None
    expected_harvest_end: date | None = None
    actual_harvest_date: date | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("container", "medium", "location", "notes")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @model_validator(mode="after")
    def validate_record(self) -> Self:
        if self.propagation_source is PropagationSource.CLONE and self.seed_type is not None:
            raise ValueError("Clones do not carry a seed type")
        if self.status in _STATUS_REQUIRES_START and self.start_date is None:
            raise ValueError("Start date is required once a Plant is active")
        if self.actual_harvest_date is not None and self.status not in _HARVEST_STATUSES:
            raise ValueError("Actual harvest date is only valid for harvested or completed Plants")
        if (
            self.expected_harvest_start
            and self.expected_harvest_end
            and self.expected_harvest_end < self.expected_harvest_start
        ):
            raise ValueError("Expected harvest end cannot precede its start")
        return self


class PlantUpdate(BaseModel):
    """Patch mutable Plant fields; stage changes use transitions."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    seed_type: SeedType | None = None
    start_date: date | None = None
    status: PlantStatus | None = None
    container: str | None = None
    medium: str | None = None
    location: str | None = None
    expected_harvest_start: date | None = None
    expected_harvest_end: date | None = None
    actual_harvest_date: date | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value)

    @field_validator("container", "medium", "location", "notes")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)


class PlantStageTransitionCreate(BaseModel):
    """Record one append-only stage transition."""

    to_stage_id: str
    effective_at: datetime
    source: TransitionSource | None = None
    notes: str | None = None
    confirmed: bool = False

    @field_validator("notes")
    @classmethod
    def clean_notes(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("effective_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("Effective time must include a timezone")
        return value


class CompactStage(BaseModel):
    """Compact lifecycle stage identity."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    key: str
    label: str


class CompactRef(BaseModel):
    """Compact identity reference for nested Grow, Grow Space, and cultivar."""

    id: str
    name: str


class CompactCultivar(BaseModel):
    """Compact cultivar identity with optional breeder name."""

    id: str
    name: str
    breeder_name: str | None


class TransitionResponse(BaseModel):
    """Persisted stage transition representation."""

    id: str
    from_stage_id: str | None
    to_stage_id: str
    effective_at: datetime
    source: TransitionSource
    notes: str | None
    created_at: datetime


class PlantResponse(BaseModel):
    """Detailed Plant representation with ordered transition history."""

    id: str
    grow: CompactRef
    grow_space: CompactRef
    cultivar: CompactCultivar
    name: str
    propagation_source: PropagationSource
    seed_type: SeedType | None
    start_date: date | None
    current_stage: CompactStage
    status: PlantStatus
    container: str | None
    medium: str | None
    location: str | None
    expected_harvest_start: date | None
    expected_harvest_end: date | None
    actual_harvest_date: date | None
    notes: str | None
    stage_transitions: list[TransitionResponse]
    created_at: datetime
    updated_at: datetime


class PlantSummary(BaseModel):
    """Compact Plant list representation."""

    id: str
    grow_id: str
    name: str
    status: PlantStatus
    current_stage: CompactStage
    cultivar: CompactCultivar
    start_date: date | None


class PlantListResponse(BaseModel):
    """Stable list envelope for Plants."""

    items: list[PlantSummary]


class PlantStageTransitionResult(BaseModel):
    """The created transition and the refreshed Plant projection."""

    transition: TransitionResponse
    plant: PlantResponse
