"""Pure domain vocabulary for journal entries, measurements, and photos."""

from enum import StrEnum


class JournalSubjectType(StrEnum):
    """What a journal entry describes."""

    PLANT = "plant"
    GROW = "grow"


class JournalEntryType(StrEnum):
    """Manual journal-entry categories a person chooses when writing one.

    Excludes the spec 8.4 timeline events that other domains emit
    automatically (reservoir refills, irrigation, photo capture,
    measurement recording).
    """

    WATERED = "watered"
    FED = "fed"
    TRANSPLANTED = "transplanted"
    TOPPED = "topped"
    TRAINED = "trained"
    DEFOLIATED = "defoliated"
    LIGHT_SCHEDULE_CHANGED = "light_schedule_changed"
    FLOWERING_INITIATED = "flowering_initiated"
    FIRST_FLOWERS_OBSERVED = "first_flowers_observed"
    PROBLEM_OBSERVED = "problem_observed"
    TREATMENT_APPLIED = "treatment_applied"
    HARVESTED = "harvested"
    DRYING_STARTED = "drying_started"
    JARRED = "jarred"
    CURE_MILESTONE = "cure_milestone"
    NOTE = "note"


class MeasurementMetric(StrEnum):
    """Supported Plant measurement metrics."""

    HEIGHT = "height"
    WIDTH = "width"
    CANOPY_DIAMETER = "canopy_diameter"
    STEM_DIAMETER = "stem_diameter"
    NODE_COUNT = "node_count"
    CONTAINER_WEIGHT = "container_weight"
    PLANT_WEIGHT = "plant_weight"
    CUSTOM = "custom"


PHOTO_CONTENT_TYPES: frozenset[str] = frozenset({"image/jpeg", "image/png", "image/webp"})


def requires_custom_metric_name(metric: MeasurementMetric, custom_name: str | None) -> bool:
    """Return whether a custom metric name is missing for a custom measurement."""
    return metric is MeasurementMetric.CUSTOM and not custom_name
