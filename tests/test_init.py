"""Tests for Sunrise Alarm config-entry lifecycle and actions."""

from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

from homeassistant.const import ATTR_DEVICE_ID
from homeassistant.helpers import device_registry as dr
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.sunrise_alarm.const import DOMAIN
from custom_components.sunrise_alarm.controller import SunriseAlarmController

from .test_models import valid_data, valid_options

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant


ROOT = Path(__file__).parents[1]


def test_repository_metadata_and_documentation() -> None:
    """Repository metadata advertises the tested baseline and limitations."""
    manifest = json.loads(
        (ROOT / "custom_components/sunrise_alarm/manifest.json").read_text()
    )
    hacs = json.loads((ROOT / "hacs.json").read_text())
    readme = (ROOT / "README.md").read_text()

    assert manifest["domain"] == DOMAIN
    assert manifest["config_flow"] is True
    assert hacs["homeassistant"] == "2026.7.4"
    for heading in (
        "Installation",
        "Setup",
        "Daylight-saving time",
        "Restart recovery",
        "Light compatibility",
        "Reliability",
    ):
        assert f"## {heading}" in readme
    assert "Apple Sleep Schedule" in readme
    assert "not a safety-critical alarm" in readme


def make_entry() -> MockConfigEntry:
    """Create a valid Sunrise Alarm config entry."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Bedroom",
        data=valid_data(),
        options=valid_options(),
        unique_id="alarm-1",
    )


async def test_setup_and_unload_entry(hass: HomeAssistant) -> None:
    """Setup owns one controller and unload shuts it down."""
    entry = make_entry()
    entry.add_to_hass(hass)

    assert await hass.config_entries.async_setup(entry.entry_id)
    assert isinstance(entry.runtime_data, SunriseAlarmController)
    assert entry.runtime_data.next_occurrence is not None

    controller = entry.runtime_data
    controller.async_shutdown = AsyncMock(wraps=controller.async_shutdown)
    assert await hass.config_entries.async_unload(entry.entry_id)
    controller.async_shutdown.assert_awaited_once()
    assert not hasattr(entry, "runtime_data")


async def test_device_targeted_preview_action(hass: HomeAssistant) -> None:
    """An integration action resolves only its target alarm device."""
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    controller = entry.runtime_data
    controller.async_preview = AsyncMock()
    registry = dr.async_get(hass)
    device = registry.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, controller.config.alarm_id)},
        name="Bedroom",
    )

    await hass.services.async_call(
        DOMAIN,
        "preview",
        {ATTR_DEVICE_ID: device.id, "duration": 30},
        blocking=True,
    )

    controller.async_preview.assert_awaited_once_with(duration=30)


async def test_options_update_applies_without_reload(hass: HomeAssistant) -> None:
    """Config-entry option updates are applied to the existing controller."""
    entry = make_entry()
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    controller = entry.runtime_data
    controller.async_apply_config = AsyncMock()

    hass.config_entries.async_update_entry(
        entry,
        options=valid_options() | {"wake_time": "08:00:00"},
    )
    await hass.async_block_till_done()

    controller.async_apply_config.assert_awaited_once()
    applied = controller.async_apply_config.await_args.args[0]
    assert applied.schedule.wake_time.hour == 8
