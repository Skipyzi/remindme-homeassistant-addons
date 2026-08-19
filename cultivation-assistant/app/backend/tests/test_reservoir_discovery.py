from typing import Any

from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.reservoirs.discovery import EntityDiscoveryService


def state(
    entity_id: str,
    value: str,
    unit: str | None,
    device_class: str | None,
    friendly_name: str,
) -> dict[str, Any]:
    return {
        "entity_id": entity_id,
        "state": value,
        "last_updated": "2026-07-25T12:00:00Z",
        "attributes": {
            "unit_of_measurement": unit,
            "device_class": device_class,
            "friendly_name": friendly_name,
        },
    }


def test_percentage_sensor_is_compatible_with_level_percentage() -> None:
    cache = EntityStateCache()
    cache.update(state("sensor.tank_level", "72", "%", None, "Tank level"))
    candidates = EntityDiscoveryService(cache).suggest("level_percentage")
    assert candidates[0].entity_id == "sensor.tank_level"


def test_distance_sensor_converts_for_liquid_depth() -> None:
    cache = EntityStateCache()
    cache.update(state("sensor.tank_depth", "30", "cm", "distance", "Tank depth"))
    cache.update(state("sensor.tank_depth_m", "0.3", "m", "distance", "Tank depth metres"))
    candidates = EntityDiscoveryService(cache).suggest("liquid_depth")
    assert [item.entity_id for item in candidates] == [
        "sensor.tank_depth",
        "sensor.tank_depth_m",
    ]
    assert candidates[1].compatibility == "convertible"


def test_binary_sensor_matches_leak_role_by_device_class() -> None:
    cache = EntityStateCache()
    cache.update(state("binary_sensor.tray_leak", "off", None, "moisture", "Tray leak"))
    cache.update(state("sensor.unrelated", "1", None, None, "Unrelated"))
    candidates = EntityDiscoveryService(cache).suggest("leak")
    assert [item.entity_id for item in candidates] == ["binary_sensor.tray_leak"]


def test_pump_role_matches_switch_domain_only() -> None:
    cache = EntityStateCache()
    cache.update(state("switch.reservoir_pump", "on", None, None, "Reservoir pump"))
    cache.update(state("sensor.unrelated", "1", None, None, "Unrelated"))
    candidates = EntityDiscoveryService(cache).suggest("pump")
    assert [item.entity_id for item in candidates] == ["switch.reservoir_pump"]


def test_flow_role_requires_volume_flow_rate_device_class_for_top_rank() -> None:
    cache = EntityStateCache()
    cache.update(state("sensor.exact_flow", "2.5", "L/min", "volume_flow_rate", "Flow"))
    candidates = EntityDiscoveryService(cache).suggest("flow")
    assert candidates[0].entity_id == "sensor.exact_flow"
    assert candidates[0].compatibility == "compatible"


def test_unsupported_role_raises() -> None:
    cache = EntityStateCache()
    try:
        EntityDiscoveryService(cache).suggest("not_a_role")
        raised = False
    except ValueError:
        raised = True
    assert raised
