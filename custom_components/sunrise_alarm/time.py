"""Time entities for Sunrise Alarm."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.time import TimeEntity

from .const import CONF_WAKE_TIME
from .entity import SunriseAlarmEntity

if TYPE_CHECKING:
    from datetime import time

    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

    from . import SunriseAlarmConfigEntry


async def async_setup_entry(
    _hass: HomeAssistant,
    entry: SunriseAlarmConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up fixed wake-time editor."""
    async_add_entities([WakeTimeEntity(entry)])


class WakeTimeEntity(SunriseAlarmEntity, TimeEntity):
    """Edit the fixed provider wake time."""

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "wake_time")

    @property
    def native_value(self) -> time:
        """Return configured local wake time."""
        return self.controller.config.schedule.wake_time

    async def async_set_value(self, value: time) -> None:
        """Persist a new local wake time through config-entry options."""
        self.hass.config_entries.async_update_entry(
            self.entry,
            options={**self.entry.options, CONF_WAKE_TIME: value.isoformat()},
        )
