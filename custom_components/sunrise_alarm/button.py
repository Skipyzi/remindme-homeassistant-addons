"""Button entities for Sunrise Alarm."""

from __future__ import annotations

from typing import TYPE_CHECKING

from homeassistant.components.button import ButtonEntity

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
    """Set up alarm command buttons."""
    async_add_entities([StopButton(entry), SkipNextButton(entry), PreviewButton(entry)])


class StopButton(SunriseAlarmEntity, ButtonEntity):
    """Stop active alarm output."""

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "stop")

    @property
    def available(self) -> bool:
        """Stop is available only while output is active."""
        return super().available and self.controller.is_active

    async def async_press(self) -> None:
        """Stop active output."""
        await self.controller.async_stop()


class SkipNextButton(SunriseAlarmEntity, ButtonEntity):
    """Skip the exact next occurrence."""

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "skip_next")

    @property
    def available(self) -> bool:
        """Skip is available when an occurrence exists."""
        return super().available and self.controller.next_occurrence is not None

    async def async_press(self) -> None:
        """Skip the next occurrence."""
        await self.controller.async_skip_next()


class PreviewButton(SunriseAlarmEntity, ButtonEntity):
    """Run an isolated shortened preview."""

    def __init__(self, entry: SunriseAlarmConfigEntry) -> None:
        super().__init__(entry, "preview")

    @property
    def available(self) -> bool:
        """Preview is unavailable during active output."""
        return super().available and not self.controller.is_active

    async def async_press(self) -> None:
        """Start the default preview."""
        await self.controller.async_preview()
