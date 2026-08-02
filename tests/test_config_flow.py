"""Tests for Sunrise Alarm config and options flows."""

from __future__ import annotations

from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

from homeassistant import config_entries
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.sunrise_alarm.const import DOMAIN

from .test_models import valid_data, valid_options

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant


def make_entry() -> MockConfigEntry:
    """Create an existing valid alarm entry."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Bedroom",
        data=valid_data(),
        options=valid_options(),
        unique_id="alarm-1",
    )


async def advance_to_review(hass: HomeAssistant) -> dict:
    """Drive a valid initial flow to its review step."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            "name": "Bedroom",
            "area_id": "bedroom",
            "timezone": "Europe/Berlin",
        },
    )
    assert result["step_id"] == "schedule"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            "wake_time": "07:00:00",
            "weekdays": [0, 1, 2, 3, 4],
            "enabled": True,
        },
    )
    assert result["step_id"] == "lights"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {
            "lights": ["light.left", "light.right"],
            "duration_minutes": 30,
            "start_brightness": 1,
            "end_brightness": 100,
            "start_kelvin": 2200,
            "end_kelvin": 4000,
            "curve": "natural",
            "update_interval": 10,
        },
    )
    assert result["step_id"] == "behavior"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"stop_on_manual_off": False},
    )
    assert result["step_id"] == "review"
    return result


async def test_successful_initial_flow(hass: HomeAssistant) -> None:
    """The wizard creates identity data and one authoritative options map."""
    result = await advance_to_review(hass)
    assert "next_wake" in result["description_placeholders"]
    assert "sunrise_start" in result["description_placeholders"]

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {"action": "finish"}
    )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Bedroom"
    assert result["data"]["provider"] == "fixed_schedule"
    assert result["data"]["timezone"] == "Europe/Berlin"
    assert result["options"]["wake_time"] == "07:00:00"


async def test_no_weekdays_returns_translation_error(hass: HomeAssistant) -> None:
    """Schedule validation uses a translatable actionable error."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN,
        context={"source": config_entries.SOURCE_USER},
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"name": "Bedroom", "timezone": "Europe/Berlin"},
    )
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {"wake_time": "07:00:00", "weekdays": [], "enabled": True},
    )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"weekdays": "no_weekdays"}


async def test_review_preview_does_not_create_entry(hass: HomeAssistant) -> None:
    """Review preview returns to review without finishing setup."""
    result = await advance_to_review(hass)
    preview = AsyncMock()

    with patch(
        "custom_components.sunrise_alarm.config_flow.async_run_flow_preview",
        preview,
    ):
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {"action": "preview"}
        )

    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "review"
    preview.assert_awaited_once()


async def test_options_flow_updates_schedule(hass: HomeAssistant) -> None:
    """Options flow replaces editable values while preserving identity."""
    entry = make_entry()
    entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(entry.entry_id)
    assert result["step_id"] == "schedule"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "wake_time": "08:00:00",
            "weekdays": [0, 1, 2, 3, 4],
            "enabled": True,
        },
    )
    options = valid_options()
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            "lights": options["lights"],
            "duration_minutes": options["duration_minutes"],
            "start_brightness": options["start_brightness"],
            "end_brightness": options["end_brightness"],
            "start_kelvin": options["start_kelvin"],
            "end_kelvin": options["end_kelvin"],
            "curve": options["curve"],
            "update_interval": options["update_interval"],
        },
    )
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"stop_on_manual_off": True}
    )
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"action": "finish"}
    )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["wake_time"] == "08:00:00"
    assert result["data"]["stop_on_manual_off"] is True
    assert entry.data["alarm_id"] == "alarm-1"
