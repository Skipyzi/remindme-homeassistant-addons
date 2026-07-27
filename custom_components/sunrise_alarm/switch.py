"""Switch entities for Sunrise Alarm."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.switch import SwitchEntity

from .const import CONF_ENABLED
from .entity import SunriseAlarmEntity

if TYPE_CHECKING:
    from typing import Any

    from homeassistant.core import HomeAssistant
    from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

    from . import SunriseAlarmConfigEntry


async def async_setup_entry(
    _hass: HomeAssistant,
    entry: SunriseAlarmConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up enabled switch."""
    async_add_entities([AlarmEnabledSwitch(entry)])


class AlarmEnabledSwitch(SunriseAlarmEntity, SwitchEntity):
    """Enable or disable recurring scheduling."""

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "enabled")

    @property
    def is_on(self) -> bool:
        """Return configured enabled state."""
        return self.controller.config.enabled

    async def async_turn_on(self, **_kwargs: Any) -> None:
        """Enable scheduling."""
        await self._async_set_enabled(enabled=True)

    async def async_turn_off(self, **_kwargs: Any) -> None:
        """Disable scheduling."""
        await self._async_set_enabled(enabled=False)

    async def _async_set_enabled(self, *, enabled: bool) -> None:
        await self.controller.async_set_enabled(enabled=enabled)
        self.hass.config_entries.async_update_entry(
            self.entry,
            options={**self.entry.options, CONF_ENABLED: enabled},
        )
