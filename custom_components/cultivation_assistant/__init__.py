# pyright: reportMissingImports=false
"""Cultivation Assistant companion integration."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.core import HomeAssistant

from custom_components.cultivation_assistant.const import DOMAIN, PLATFORMS


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up the app-health coordinator for one local app instance."""
    from homeassistant.const import CONF_URL
    from homeassistant.helpers.aiohttp_client import async_get_clientsession

    from custom_components.cultivation_assistant.api import CultivationAssistantApi
    from custom_components.cultivation_assistant.coordinator import (
        CultivationAssistantCoordinator,
    )

    api = CultivationAssistantApi(async_get_clientsession(hass), entry.data[CONF_URL])
    coordinator = CultivationAssistantCoordinator(hass, api)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload all platforms and remove coordinator state."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data[DOMAIN].pop(entry.entry_id)
    return unloaded
