"""Tests for capability-aware light output."""

from __future__ import annotations

from datetime import timedelta
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

from homeassistant.components.light import (
    ATTR_BRIGHTNESS_PCT,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_MAX_COLOR_TEMP_KELVIN,
    ATTR_MIN_COLOR_TEMP_KELVIN,
    ATTR_RGB_COLOR,
    ATTR_SUPPORTED_COLOR_MODES,
    SERVICE_TURN_ON,
    ColorMode,
)
from homeassistant.components.light import (
    DOMAIN as LIGHT_DOMAIN,
)
from homeassistant.const import ATTR_ENTITY_ID, STATE_UNAVAILABLE
from homeassistant.core import Context
from homeassistant.exceptions import HomeAssistantError

from custom_components.sunrise_alarm.light_engine import LightEngine
from custom_components.sunrise_alarm.models import LightRampConfig, RampCurve

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant, ServiceCall


def ramp_config(entity_ids: tuple[str, ...]) -> LightRampConfig:
    """Build a representative linear light ramp."""
    return LightRampConfig(
        entity_ids=entity_ids,
        duration=timedelta(minutes=30),
        start_brightness=1,
        end_brightness=100,
        start_kelvin=2200,
        end_kelvin=4000,
        curve=RampCurve.LINEAR,
        update_interval=timedelta(seconds=10),
    )


def set_light_states(hass: HomeAssistant) -> None:
    """Create representative heterogeneous light states."""
    hass.states.async_set(
        "light.temp",
        "on",
        {
            ATTR_SUPPORTED_COLOR_MODES: [ColorMode.COLOR_TEMP],
            ATTR_MIN_COLOR_TEMP_KELVIN: 2000,
            ATTR_MAX_COLOR_TEMP_KELVIN: 4500,
        },
    )
    hass.states.async_set(
        "light.rgb",
        "on",
        {ATTR_SUPPORTED_COLOR_MODES: [ColorMode.RGB]},
    )
    hass.states.async_set(
        "light.dim",
        "on",
        {ATTR_SUPPORTED_COLOR_MODES: [ColorMode.BRIGHTNESS]},
    )
    hass.states.async_set(
        "light.relay",
        "off",
        {ATTR_SUPPORTED_COLOR_MODES: [ColorMode.ONOFF]},
    )
    hass.states.async_set(
        "light.missing",
        STATE_UNAVAILABLE,
        {ATTR_SUPPORTED_COLOR_MODES: [ColorMode.BRIGHTNESS]},
    )


async def test_apply_filters_attributes_by_capability(hass: HomeAssistant) -> None:
    """Each light receives only attributes supported by its current mode."""
    set_light_states(hass)
    calls: list[ServiceCall] = []

    async def capture(call: ServiceCall) -> None:
        calls.append(call)

    hass.services.async_register(LIGHT_DOMAIN, SERVICE_TURN_ON, capture)
    engine = LightEngine(hass)
    config = ramp_config(
        ("light.temp", "light.rgb", "light.dim", "light.relay", "light.missing")
    )

    result = await engine.async_apply(config, 0.0, Context())

    by_entity = {call.data[ATTR_ENTITY_ID]: call.data for call in calls}
    assert by_entity["light.temp"][ATTR_COLOR_TEMP_KELVIN] == 2200
    assert ATTR_RGB_COLOR not in by_entity["light.temp"]
    assert ATTR_RGB_COLOR in by_entity["light.rgb"]
    assert ATTR_COLOR_TEMP_KELVIN not in by_entity["light.rgb"]
    assert set(by_entity["light.dim"]) == {ATTR_ENTITY_ID, ATTR_BRIGHTNESS_PCT}
    assert by_entity["light.relay"] == {ATTR_ENTITY_ID: "light.relay"}
    assert result.succeeded == (
        "light.temp",
        "light.rgb",
        "light.dim",
        "light.relay",
    )
    assert result.failed == ("light.missing",)
    assert result.degraded is False


async def test_apply_clamps_kelvin_to_entity_range(hass: HomeAssistant) -> None:
    """Colour temperature is clamped for each selected light."""
    set_light_states(hass)
    calls: list[ServiceCall] = []

    async def capture(call: ServiceCall) -> None:
        calls.append(call)

    hass.services.async_register(LIGHT_DOMAIN, SERVICE_TURN_ON, capture)
    config = ramp_config(("light.temp",))
    config = LightRampConfig(
        config.entity_ids,
        config.duration,
        config.start_brightness,
        config.end_brightness,
        1800,
        config.end_kelvin,
        config.curve,
        config.update_interval,
    )

    await LightEngine(hass).async_apply(config, 0.0, Context())

    assert calls[0].data[ATTR_COLOR_TEMP_KELVIN] == 2000


async def test_service_failure_does_not_block_other_lights(
    hass: HomeAssistant,
) -> None:
    """A failed light is isolated from later outputs."""
    set_light_states(hass)

    async def fail_one(call: ServiceCall) -> None:
        if call.data[ATTR_ENTITY_ID] == "light.rgb":
            message = "offline"
            raise HomeAssistantError(message)

    hass.services.async_register(LIGHT_DOMAIN, SERVICE_TURN_ON, fail_one)

    result = await LightEngine(hass).async_apply(
        ramp_config(("light.rgb", "light.dim")), 0.5, Context()
    )

    assert result.succeeded == ("light.dim",)
    assert result.failed == ("light.rgb",)
    assert result.degraded is False


async def test_all_failures_are_degraded(hass: HomeAssistant) -> None:
    """No successful output marks the step degraded without raising."""
    set_light_states(hass)

    result = await LightEngine(hass).async_apply(
        ramp_config(("light.missing",)), 0.5, Context()
    )

    assert result.succeeded == ()
    assert result.failed == ("light.missing",)
    assert result.degraded is True


async def test_manual_off_monitor_stops_only_after_all_lights_are_off(
    hass: HomeAssistant,
) -> None:
    """External all-off transitions trigger the supplied stop callback once."""
    set_light_states(hass)
    engine = LightEngine(hass)
    stopped = AsyncMock()
    cancel = engine.async_start_manual_off_monitor(("light.temp", "light.rgb"), stopped)

    hass.states.async_set("light.temp", "off", context=Context())
    await hass.async_block_till_done()
    stopped.assert_not_awaited()

    hass.states.async_set("light.rgb", "off", context=Context())
    await hass.async_block_till_done()
    stopped.assert_awaited_once()
    cancel()


async def test_manual_off_monitor_ignores_engine_context(hass: HomeAssistant) -> None:
    """Integration-issued state changes are not mistaken for manual input."""
    set_light_states(hass)
    engine = LightEngine(hass)
    stopped = AsyncMock()
    own_context = Context()
    with patch(
        "custom_components.sunrise_alarm.light_engine.async_reproduce_state",
        AsyncMock(),
    ):
        await engine.async_restore([], own_context)
    cancel = engine.async_start_manual_off_monitor(("light.temp", "light.rgb"), stopped)

    hass.states.async_set("light.temp", "off", context=own_context)
    hass.states.async_set("light.rgb", "off", context=own_context)
    await hass.async_block_till_done()

    stopped.assert_not_awaited()
    cancel()


async def test_snapshot_restore_and_context_tracking(hass: HomeAssistant) -> None:
    """Preview snapshots restore through HA and own contexts are identifiable."""
    set_light_states(hass)
    engine = LightEngine(hass)
    states = engine.async_snapshot(("light.temp", "light.rgb", "light.unknown"))
    restore = AsyncMock()

    with patch(
        "custom_components.sunrise_alarm.light_engine.async_reproduce_state",
        restore,
    ):
        context = Context()
        await engine.async_restore(states, context)

    assert [state.entity_id for state in states] == ["light.temp", "light.rgb"]
    restore.assert_awaited_once_with(hass, states, context=context)
    assert engine.is_own_context(context.id)
