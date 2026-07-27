"""Shared entity support for Sunrise Alarm."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.entity import Entity

from .const import DOMAIN

if TYPE_CHECKING:
    from . import SunriseAlarmConfigEntry
    from .controller import SunriseAlarmController


class SunriseAlarmEntity(Entity):
    """Base entity backed by one alarm controller."""

    _attr_has_entity_name = True

    def __init__(self, entry: SunriseAlarmConfigEntry, key: str) -> None:
        """Initialize shared identity and device metadata."""
        self.entry = entry
        self.controller: SunriseAlarmController = entry.runtime_data
        self._attr_unique_id = f"{self.controller.config.alarm_id}_{key}"
        self._attr_translation_key = key
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, self.controller.config.alarm_id)},
            name=self.controller.config.name,
            manufacturer="Sunrise Alarm",
            model="Weekly Sunrise Alarm",
            suggested_area=self.controller.config.area_id,
        )

    @property
    def available(self) -> bool:
        """Return controller availability."""
        return self.controller.available

    async def async_added_to_hass(self) -> None:
        """Subscribe this entity to controller changes."""
        await super().async_added_to_hass()
        self.async_on_remove(
            self.controller.async_add_listener(self.async_write_ha_state)
        )
