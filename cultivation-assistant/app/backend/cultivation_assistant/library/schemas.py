"""Validated HTTP and application contracts for breeders and cultivars."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator

from cultivation_assistant.lifecycle.rules import SeedType


def _clean_required(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("A non-empty value is required")
    return cleaned


class BreederCreate(BaseModel):
    """Create one minimal breeder identity."""

    name: str = Field(min_length=1, max_length=160)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_required(value)


class BreederUpdate(BaseModel):
    """Patch mutable breeder fields."""

    name: str | None = Field(default=None, min_length=1, max_length=160)
    active: bool | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_required(value)


class BreederResponse(BaseModel):
    """Persisted breeder representation."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    active: bool
    created_at: datetime
    updated_at: datetime


class BreederListResponse(BaseModel):
    """Stable list envelope for breeders."""

    items: list[BreederResponse]


class CompactBreeder(BaseModel):
    """Compact nested breeder identity inside cultivar responses."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str


class CultivarCreate(BaseModel):
    """Create one minimal cultivar identity with an optional breeder."""

    name: str = Field(min_length=1, max_length=160)
    breeder_id: str | None = None
    seed_type: SeedType = SeedType.UNKNOWN

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_required(value)


class CultivarUpdate(BaseModel):
    """Patch mutable cultivar fields."""

    name: str | None = Field(default=None, min_length=1, max_length=160)
    breeder_id: str | None = None
    seed_type: SeedType | None = None
    active: bool | None = None

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str | None) -> str | None:
        return None if value is None else _clean_required(value)

    def clears_breeder(self) -> bool:
        """Return true when the caller explicitly set ``breeder_id`` to null."""
        return "breeder_id" in self.model_fields_set and self.breeder_id is None


class CultivarResponse(BaseModel):
    """Persisted cultivar representation with compact breeder identity."""

    id: str
    name: str
    breeder: CompactBreeder | None
    seed_type: SeedType
    active: bool
    created_at: datetime
    updated_at: datetime


class CultivarListResponse(BaseModel):
    """Stable list envelope for cultivars."""

    items: list[CultivarResponse]
