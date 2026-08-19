# pyright: reportMissingImports=false
# pyright: reportUnknownVariableType=false, reportUnknownMemberType=false
from datetime import UTC, datetime, timedelta

from cultivation_assistant.home_assistant.state_cache import EntityStateCache


def test_state_cache_ignores_older_duplicate_events() -> None:
    cache = EntityStateCache()
    newer = {
        "entity_id": "sensor.tent_temperature",
        "state": "25.4",
        "attributes": {"unit_of_measurement": "°C"},
        "last_updated": "2026-07-22T18:02:00+00:00",
    }
    older = {**newer, "state": "24.9", "last_updated": "2026-07-22T18:01:00+00:00"}

    assert cache.update(newer)
    assert not cache.update(older)
    assert cache.get("sensor.tent_temperature").state == "25.4"


def test_state_cache_marks_old_readings_stale() -> None:
    cache = EntityStateCache()
    now = datetime(2026, 7, 22, 18, 10, tzinfo=UTC)
    cache.update(
        {
            "entity_id": "sensor.tent_humidity",
            "state": "61",
            "attributes": {},
            "last_updated": (now - timedelta(minutes=6)).isoformat(),
        }
    )

    assert cache.is_stale("sensor.tent_humidity", timedelta(minutes=5), now=now)
