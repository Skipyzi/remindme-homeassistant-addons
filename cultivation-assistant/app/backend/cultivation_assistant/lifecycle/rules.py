"""Pure lifecycle vocabulary and deterministic transition rules."""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum


class GrowStatus(StrEnum):
    """Lifecycle status of a Grow."""

    PLANNED = "planned"
    ACTIVE = "active"
    COMPLETED = "completed"
    ARCHIVED = "archived"


class PlantStatus(StrEnum):
    """Lifecycle status of an individual Plant."""

    PLANNED = "planned"
    ACTIVE = "active"
    HARVESTED = "harvested"
    COMPLETED = "completed"
    LOST = "lost"
    ARCHIVED = "archived"


class PropagationSource(StrEnum):
    """Origin of a Plant."""

    SEED = "seed"
    CLONE = "clone"


class SeedType(StrEnum):
    """Genetic seed classification."""

    REGULAR = "regular"
    FEMINIZED = "feminized"
    AUTOFLOWER = "autoflower"
    UNKNOWN = "unknown"


class TransitionSource(StrEnum):
    """Provenance of a recorded stage transition."""

    USER_CONFIRMED = "user_confirmed"
    USER_ADJUSTED = "user_adjusted"
    IMPORTED = "imported"
    APPLICATION_RECALCULATION = "application_recalculation"


@dataclass(frozen=True, slots=True)
class TransitionOrder:
    """Minimal ordering view of one persisted stage transition."""

    id: str
    to_stage_id: str
    effective_at: datetime
    created_at: datetime


def ordered_current_stage(transitions: Iterable[TransitionOrder]) -> str:
    """Return the stage of the latest transition by effective time, creation, then ID."""
    ordered = max(transitions, key=lambda item: (item.effective_at, item.created_at, item.id))
    return ordered.to_stage_id


def requires_transition_confirmation(
    stage_ids: Sequence[str], current_id: str, target_id: str
) -> bool:
    """Return true for backward or skipped movement in the enabled stage order."""
    return stage_ids.index(target_id) != stage_ids.index(current_id) + 1
