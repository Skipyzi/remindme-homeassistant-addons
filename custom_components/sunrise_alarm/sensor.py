"""Sensor entities for Sunrise Alarm."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity

from .entity import SunriseAlarmEntity

if TYPE_CHECKING:
    from datetime import datetime

    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

    from . import SunriseAlarmConfigEntry


async def async_setup_entry(
    _hass: HomeAssistant,
    entry: SunriseAlarmConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up next-alarm and status sensors."""
    async_add_entities([NextAlarmSensor(entry), AlarmStatusSensor(entry)])


class NextAlarmSensor(SunriseAlarmEntity, SensorEntity):
    """Expose the next calculated wake timestamp."""

    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "next_alarm")

    @property
    def native_value(self) -> datetime | None:
        """Return next wake time."""
        occurrence = self.controller.next_occurrence
        return occurrence.wake_time if occurrence else None


class AlarmStatusSensor(SunriseAlarmEntity, SensorEntity):
    """Expose current controller state."""

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "status")

    @property
    def native_value(self) -> str:
        """Return state-machine value."""
        return self.controller.state
