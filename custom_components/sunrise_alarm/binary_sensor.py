"""Binary sensor entities for Sunrise Alarm."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.binary_sensor import BinarySensorEntity

from .entity import SunriseAlarmEntity

if TYPE_CHECKING:
    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

    from . import SunriseAlarmConfigEntry


async def async_setup_entry(
    _hass: HomeAssistant,
    entry: SunriseAlarmConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up active indicator."""
    async_add_entities([AlarmActiveBinarySensor(entry)])


class AlarmActiveBinarySensor(SunriseAlarmEntity, BinarySensorEntity):
    """Indicate whether an occurrence or preview is active."""

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "active")

    @property
    def is_on(self) -> bool:
        """Return active state."""
        return self.controller.is_active
