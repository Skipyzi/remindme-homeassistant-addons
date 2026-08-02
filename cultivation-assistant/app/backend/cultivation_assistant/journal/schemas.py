"""Validated HTTP and application contracts for the journal slice."""

from datetime import UTC, datetime
from typing import Self

from pydantic import BaseModel, Field, field_validator, model_validator

from cultivation_assistant.journal.rules import (
    JournalEntryType,
    JournalSubjectType,
    MeasurementMetric,
    requires_custom_metric_name,
)


def _clean_optional(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _require_timezone(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("Timestamp must include a timezone")
    return value


class CompactStageRef(BaseModel):
    """Compact lifecycle stage identity, reused from the lifecycle slice shape."""

    id: str
    key: str
    label: str


class JournalEntryCreate(BaseModel):
    """Create one journal entry for a Plant or a Grow."""

    entry_type: JournalEntryType = JournalEntryType.NOTE
    occurred_at: datetime | None = None
    title: str | None = Field(default=None, max_length=200)
    notes: str | None = None
    tags: list[str] = Field(default_factory=list)
    related_stage_id: str | None = None
    related_issue: str | None = None

    @field_validator("title", "notes", "related_issue")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("occurred_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _require_timezone(value)


class JournalEntryUpdate(BaseModel):
    """Patch mutable journal entry fields."""

    entry_type: JournalEntryType | None = None
    occurred_at: datetime | None = None
    title: str | None = Field(default=None, max_length=200)
    notes: str | None = None
    tags: list[str] | None = None
    related_stage_id: str | None = None
    related_issue: str | None = None

    @field_validator("title", "notes", "related_issue")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("occurred_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _require_timezone(value)


class JournalEntryResponse(BaseModel):
    """Persisted journal entry representation."""

    id: str
    subject_type: JournalSubjectType
    subject_id: str
    entry_type: JournalEntryType
    occurred_at: datetime
    title: str | None
    notes: str | None
    tags: list[str]
    related_stage: CompactStageRef | None
    related_issue: str | None
    created_at: datetime
    updated_at: datetime


class JournalEntryListResponse(BaseModel):
    """Stable list envelope for journal entries."""

    items: list[JournalEntryResponse]


def default_occurred_at() -> datetime:
    """The timestamp a journal entry gets when none is supplied."""
    return datetime.now(UTC)


class MeasurementCreate(BaseModel):
    """Create one quantitative reading against a Plant."""

    metric_type: MeasurementMetric
    custom_metric_name: str | None = Field(default=None, max_length=120)
    value: float
    unit: str = Field(min_length=1, max_length=40)
    occurred_at: datetime | None = None
    notes: str | None = None

    @field_validator("custom_metric_name", "notes")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("occurred_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _require_timezone(value)

    @model_validator(mode="after")
    def validate_custom_metric_name(self) -> Self:
        if requires_custom_metric_name(self.metric_type, self.custom_metric_name):
            raise ValueError("A custom measurement requires a metric name")
        return self


class MeasurementUpdate(BaseModel):
    """Patch mutable measurement fields."""

    metric_type: MeasurementMetric | None = None
    custom_metric_name: str | None = Field(default=None, max_length=120)
    value: float | None = None
    unit: str | None = Field(default=None, min_length=1, max_length=40)
    occurred_at: datetime | None = None
    notes: str | None = None

    @field_validator("custom_metric_name", "notes")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)

    @field_validator("occurred_at")
    @classmethod
    def require_timezone(cls, value: datetime | None) -> datetime | None:
        return None if value is None else _require_timezone(value)


class MeasurementResponse(BaseModel):
    """Persisted measurement representation."""

    id: str
    plant_id: str
    metric_type: MeasurementMetric
    custom_metric_name: str | None
    value: float
    unit: str
    occurred_at: datetime
    notes: str | None
    created_at: datetime
    updated_at: datetime


class MeasurementListResponse(BaseModel):
    """Stable list envelope for measurements."""

    items: list[MeasurementResponse]


class PhotoUpdate(BaseModel):
    """Patch mutable photo fields: caption, tags, and optional links."""

    caption: str | None = Field(default=None, max_length=200)
    tags: list[str] | None = None
    journal_entry_id: str | None = None
    measurement_id: str | None = None

    @field_validator("caption")
    @classmethod
    def clean_optional(cls, value: str | None) -> str | None:
        return _clean_optional(value)


class PhotoResponse(BaseModel):
    """Persisted photo representation, without the internal storage path."""

    id: str
    plant_id: str
    journal_entry_id: str | None
    measurement_id: str | None
    stage: CompactStageRef | None
    caption: str | None
    tags: list[str]
    content_type: str
    file_size: int
    occurred_at: datetime
    created_at: datetime
    updated_at: datetime


class PhotoListResponse(BaseModel):
    """Stable list envelope for photos."""

    items: list[PhotoResponse]


class TimelineStageTransition(BaseModel):
    """Compact stage-transition representation for the activity timeline."""

    id: str
    from_stage: CompactStageRef | None
    to_stage: CompactStageRef
    effective_at: datetime
    source: str
    notes: str | None
    created_at: datetime


class TimelineEntryResponse(BaseModel):
    """One merged activity-timeline entry; exactly one detail field is set."""

    id: str
    event_type: str
    occurred_at: datetime
    summary: str
    journal_entry: JournalEntryResponse | None = None
    measurement: MeasurementResponse | None = None
    photo: PhotoResponse | None = None
    stage_transition: TimelineStageTransition | None = None


class TimelineListResponse(BaseModel):
    """Paginated envelope for a Plant's merged activity timeline."""

    items: list[TimelineEntryResponse]
