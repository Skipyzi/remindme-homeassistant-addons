"""Sunrise Alarm integration lifecycle and actions."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_DEVICE_ID, Platform
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import device_registry as dr

from .const import DOMAIN
from .controller import SunriseAlarmController
from .ha_runtime import HomeAssistantRuntime
from .light_engine import LightEngine
from .models import AlarmConfig
from .storage import AlarmStore

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant, ServiceCall

SunriseAlarmConfigEntry = ConfigEntry[SunriseAlarmController]

_SERVICE_STOP = "stop"
_SERVICE_SKIP_NEXT = "skip_next"
_SERVICE_CLEAR_SKIP = "clear_skip"
_SERVICE_PREVIEW = "preview"
_SERVICES_REGISTERED = "services_registered"
_PLATFORMS = (
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.NUMBER,
    Platform.SENSOR,
    Platform.SWITCH,
    Platform.TIME,
)


def _target_schema(extra: dict[vol.Marker, Any] | None = None) -> vol.Schema:
    """Create a device-targeted action schema."""
    fields: dict[vol.Marker, Any] = {
        vol.Required(ATTR_DEVICE_ID): vol.All(cv.ensure_list, [str])
    }
    if extra:
        fields.update(extra)
    return vol.Schema(fields)


async def async_setup(hass: HomeAssistant, _config: dict[str, object]) -> bool:
    """Set up integration actions once."""
    domain_data = hass.data.setdefault(DOMAIN, {})
    if domain_data.get(_SERVICES_REGISTERED):
        return True

    async def handle_action(call: ServiceCall) -> None:
        controllers = _controllers_for_devices(hass, call.data[ATTR_DEVICE_ID])
        if not controllers:
            message = "No Sunrise Alarm controller matches the selected device"
            raise ServiceValidationError(message)
        for controller in controllers:
            if call.service == _SERVICE_STOP:
                await controller.async_stop()
            elif call.service == _SERVICE_SKIP_NEXT:
                await controller.async_skip_next()
            elif call.service == _SERVICE_CLEAR_SKIP:
                await controller.async_clear_skip()
            else:
                await controller.async_preview(duration=call.data["duration"])

    hass.services.async_register(
        DOMAIN,
        _SERVICE_STOP,
        handle_action,
        schema=_target_schema(),
    )
    hass.services.async_register(
        DOMAIN,
        _SERVICE_SKIP_NEXT,
        handle_action,
        schema=_target_schema(),
    )
    hass.services.async_register(
        DOMAIN,
        _SERVICE_CLEAR_SKIP,
        handle_action,
        schema=_target_schema(),
    )
    hass.services.async_register(
        DOMAIN,
        _SERVICE_PREVIEW,
        handle_action,
        schema=_target_schema(
            {
                vol.Optional("duration", default=60): vol.All(
                    vol.Coerce(int),
                    vol.Range(min=1, max=600),
                )
            }
        ),
    )
    domain_data[_SERVICES_REGISTERED] = True
    return True


def _controllers_for_devices(
    hass: HomeAssistant,
    device_ids: list[str],
) -> list[SunriseAlarmController]:
    """Resolve selected integration devices to loaded controllers."""
    registry = dr.async_get(hass)
    alarm_ids = {
        identifier
        for device_id in device_ids
        if (device := registry.async_get(device_id)) is not None
        for domain, identifier in device.identifiers
        if domain == DOMAIN
    }
    return [
        entry.runtime_data
        for entry in hass.config_entries.async_entries(DOMAIN)
        if hasattr(entry, "runtime_data")
        and entry.runtime_data.config.alarm_id in alarm_ids
    ]


async def async_setup_entry(
    hass: HomeAssistant,
    entry: SunriseAlarmConfigEntry,
) -> bool:
    """Set up one Sunrise Alarm config entry."""
    config = AlarmConfig.from_mappings(entry.data, entry.options)
    controller = SunriseAlarmController(
        config,
        HomeAssistantRuntime(hass, entry.entry_id),
        LightEngine(hass),
        AlarmStore(hass, entry.entry_id),
    )
    entry.runtime_data = controller
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    await controller.async_initialize()
    await hass.config_entries.async_forward_entry_setups(entry, _PLATFORMS)
    return True


async def _async_update_listener(
    _hass: HomeAssistant,
    entry: SunriseAlarmConfigEntry,
) -> None:
    """Apply edited options without reloading platforms."""
    config = AlarmConfig.from_mappings(entry.data, entry.options)
    await entry.runtime_data.async_apply_config(config)


async def async_unload_entry(
    hass: HomeAssistant,
    entry: SunriseAlarmConfigEntry,
) -> bool:
    """Unload one alarm and remove all runtime work."""
    await entry.runtime_data.async_shutdown()
    unloaded = await hass.config_entries.async_unload_platforms(entry, _PLATFORMS)
    if unloaded:
        del entry.runtime_data
    return unloaded
