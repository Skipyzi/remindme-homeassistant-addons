"""Tests for Sunrise Alarm native entities."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

from homeassistant.const import SERVICE_TURN_OFF
from homeassistant.helpers import entity_registry as er

from custom_components.sunrise_alarm.const import DOMAIN
from custom_components.sunrise_alarm.models import AlarmState

from .test_init import make_entry

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant


def entity_id_for(hass: HomeAssistant, unique_id: str) -> str:
    """Resolve an entity ID by integration unique ID."""
    registry = er.async_get(hass)
    entry = next(
        item
        for item in registry.entities.values()
        if item.platform == DOMAIN and item.unique_id == unique_id
    )
    return entry.entity_id


async def test_alarm_device_exposes_required_entities(hass: HomeAssistant) -> None:
    """One config entry exposes the complete Milestones 1-2 entity set."""
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    registry = er.async_get(hass)
    unique_ids = {
        item.unique_id
        for item in registry.entities.values()
        if item.config_entry_id == entry.entry_id
    }
    assert unique_ids == {
        "alarm-1_enabled",
        "alarm-1_next_alarm",
        "alarm-1_status",
        "alarm-1_active",
        "alarm-1_wake_time",
        "alarm-1_duration",
        "alarm-1_stop",
        "alarm-1_skip_next",
        "alarm-1_preview",
    }
    assert hass.states.get(entity_id_for(hass, "alarm-1_status")).state == "scheduled"
    assert hass.states.get(entity_id_for(hass, "alarm-1_active")).state == "off"
    assert hass.states.get(entity_id_for(hass, "alarm-1_next_alarm")).state != "unknown"


async def test_entity_commands_delegate_to_controller(hass: HomeAssistant) -> None:
    """Buttons and switch use controller commands rather than local state."""
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    controller = entry.runtime_data
    controller.async_skip_next = AsyncMock()
    controller.async_preview = AsyncMock()

    await hass.services.async_call(
        "button",
        "press",
        {"entity_id": entity_id_for(hass, "alarm-1_skip_next")},
        blocking=True,
    )
    await hass.services.async_call(
        "button",
        "press",
        {"entity_id": entity_id_for(hass, "alarm-1_preview")},
        blocking=True,
    )

    controller.async_skip_next.assert_awaited_once()
    controller.async_preview.assert_awaited_once_with()

    await hass.services.async_call(
        "switch",
        SERVICE_TURN_OFF,
        {"entity_id": entity_id_for(hass, "alarm-1_enabled")},
        blocking=True,
    )
    assert controller.state is AlarmState.DISABLED


async def test_button_availability_follows_controller(hass: HomeAssistant) -> None:
    """Stop is active-only while skip and preview are schedule-aware."""
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    assert hass.states.get(entity_id_for(hass, "alarm-1_stop")).state == "unavailable"
    assert (
        hass.states.get(entity_id_for(hass, "alarm-1_skip_next")).state != "unavailable"
    )
    assert (
        hass.states.get(entity_id_for(hass, "alarm-1_preview")).state != "unavailable"
    )
