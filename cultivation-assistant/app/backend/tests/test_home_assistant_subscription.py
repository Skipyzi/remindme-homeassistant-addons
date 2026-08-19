# pyright: reportMissingImports=false
from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.home_assistant.subscription import (
    HomeAssistantEventSubscriber,
    exponential_backoff,
)
from pydantic import SecretStr


def test_exponential_backoff_is_bounded() -> None:
    delays = exponential_backoff(initial=1.0, maximum=4.0)

    assert [next(delays) for _ in range(5)] == [1.0, 2.0, 4.0, 4.0, 4.0]


def test_state_changed_event_updates_cache() -> None:
    cache = EntityStateCache()
    subscriber = HomeAssistantEventSubscriber(
        websocket_url="ws://supervisor/core/websocket",
        token=SecretStr("secret"),
        state_cache=cache,
    )

    updated = subscriber.process_message(
        {
            "type": "event",
            "event": {
                "event_type": "state_changed",
                "data": {
                    "new_state": {
                        "entity_id": "sensor.tent_temperature",
                        "state": "25.7",
                        "attributes": {},
                        "last_updated": "2026-07-22T18:10:00+00:00",
                    }
                },
            },
        }
    )

    assert updated
    assert cache.get("sensor.tent_temperature").state == "25.7"
