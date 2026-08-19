from cultivation_assistant.journal.rules import (
    PHOTO_CONTENT_TYPES,
    JournalEntryType,
    JournalSubjectType,
    MeasurementMetric,
    requires_custom_metric_name,
)


def test_custom_metric_requires_a_name() -> None:
    assert requires_custom_metric_name(MeasurementMetric.CUSTOM, None)
    assert not requires_custom_metric_name(MeasurementMetric.CUSTOM, "Brix")
    assert not requires_custom_metric_name(MeasurementMetric.HEIGHT, None)


def test_journal_subject_types_are_plant_or_grow() -> None:
    assert {member.value for member in JournalSubjectType} == {"plant", "grow"}


def test_journal_entry_type_covers_the_manual_vocabulary() -> None:
    values = {member.value for member in JournalEntryType}
    assert "note" in values
    assert "watered" in values
    assert "harvested" in values
    assert "reservoir_refilled" not in values
    assert "photo_added" not in values
    assert "measurement_recorded" not in values


def test_photo_content_types_are_restricted_to_common_image_formats() -> None:
    assert PHOTO_CONTENT_TYPES == {"image/jpeg", "image/png", "image/webp"}
