"""Number entities for Sunrise Alarm."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.const import UnitOfTime

from .const import CONF_DURATION_MINUTES
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
    """Set up sunrise-duration editor."""
    async_add_entities([SunriseDurationNumber(entry)])


class SunriseDurationNumber(SunriseAlarmEntity, NumberEntity):
    """Edit sunrise duration in minutes."""

    _attr_native_min_value = 1
    _attr_native_max_value = 180
    _attr_native_step = 1
    _attr_native_unit_of_measurement = UnitOfTime.MINUTES
    _attr_mode = NumberMode.SLIDER

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "duration")

    @property
    def native_value(self) -> float:
        """Return configured duration in minutes."""
        return self.controller.config.ramp.duration.total_seconds() / 60

    async def async_set_native_value(self, value: float) -> None:
        """Persist a whole-minute duration through config-entry options."""
        self.hass.config_entries.async_update_entry(
            self.entry,
            options={**self.entry.options, CONF_DURATION_MINUTES: round(value)},
        )
