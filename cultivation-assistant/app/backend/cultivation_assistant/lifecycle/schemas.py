"""Validated HTTP and application contracts for lifecycle stages."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator


class LifecycleStageResponse(BaseModel):
    """Persisted lifecycle stage representation."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    key: str
    label: str
    position: int
    enabled: bool
    built_in: bool
    created_at: datetime
    updated_at: datetime


class LifecycleStageListResponse(BaseModel):
    """Stable list envelope for lifecycle stages."""

    items: list[LifecycleStageResponse]


class LifecycleStageCreate(BaseModel):
    """Create one custom lifecycle stage appended to the end of the order."""

    key: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9_]+$")
    label: str = Field(min_length=1, max_length=120)
    enabled: bool = True

    @field_validator("label")
    @classmethod
    def clean_label(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Stage label is required")
        return cleaned


class LifecycleStageUpdate(BaseModel):
    """Patch mutable lifecycle stage fields; the stable key never changes."""

    label: str | None = Field(default=None, min_length=1, max_length=120)
    enabled: bool | None = None

    @field_validator("label")
    @classmethod
    def clean_label(cls, value: str | None) -> str | None:
        if value is None:
            return None
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Stage label cannot be blank")
        return cleaned


class LifecycleStageOrderUpdate(BaseModel):
    """Complete ordered lifecycle stage identity list."""

    stage_ids: list[str] = Field(min_length=1)

    @field_validator("stage_ids")
    @classmethod
    def unique_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("Lifecycle stage order contains duplicate IDs")
        return value
