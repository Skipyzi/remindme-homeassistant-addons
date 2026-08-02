"""Validated HTTP and application contracts for Grows."""

from datetime import date, datetime
from typing import Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from cultivation_assistant.lifecycle.rules import GrowStatus


def _clean_name(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("Grow name is required")
    return cleaned


class GrowCreate(BaseModel):
    """Create one Grow within a Grow Space."""

    grow_space_id: str
    name: str = Field(min_length=1, max_length=120)
    status: GrowStatus = GrowStatus.PLANNED
    start_date: date | None = None
    end_date: date | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("notes")
    @classmethod
    def clean_notes(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None

    @model_validator(mode="after")
    def validate_dates(self) -> Self:
        if self.status in {GrowStatus.ACTIVE, GrowStatus.COMPLETED} and self.start_date is None:
            raise ValueError("Start date is required for active or completed Grows")
        if self.start_date and self.end_date and self.end_date < self.start_date:
            raise ValueError("End date cannot precede start date")
        return self


class GrowUpdate(BaseModel):
    """Patch mutable Grow fields; date and status rules apply in the service."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    status: GrowStatus | None = None
    start_date: date | None = None
    end_date: date | None = None
    notes: str | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_name(value)

    @field_validator("notes")
    @classmethod
    def clean_notes(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        return cleaned or None


class CompactStage(BaseModel):
    """Compact lifecycle stage identity inside compact plant rows."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    key: str
    label: str


class CompactPlant(BaseModel):
    """Compact plant row inside a Grow detail."""

    id: str
    name: str
    status: str
    current_stage: CompactStage
    start_date: date | None


class GrowSummary(BaseModel):
    """Compact Grow list representation with plant counts."""

    id: str
    grow_space_id: str
    grow_space_name: str
    grow_space_active: bool
    name: str
    status: GrowStatus
    start_date: date | None
    end_date: date | None
    notes: str | None
    plant_count: int
    plant_status_counts: dict[str, int]
    created_at: datetime
    updated_at: datetime


class GrowResponse(GrowSummary):
    """Detailed Grow representation with compact plants."""

    plants: list[CompactPlant]


class GrowListResponse(BaseModel):
    """Stable list envelope for Grows."""

    items: list[GrowSummary]
