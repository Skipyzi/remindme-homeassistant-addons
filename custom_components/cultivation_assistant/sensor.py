# pyright: reportMissingImports=false
"""Diagnostic app-availability sensor."""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .api import AppHealth
from .const import DOMAIN
from .coordinator import CultivationAssistantCoordinator

if TYPE_CHECKING:
    from homeassistant.config_entries import ConfigEntry
    from homeassistant.core import HomeAssistant


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: Callable[[list[SensorEntity]], None],
) -> None:
    """Set up one availability sensor per configured app."""
    coordinator: CultivationAssistantCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([CultivationAssistantAvailabilitySensor(coordinator, entry.entry_id)])


class CultivationAssistantAvailabilitySensor(CoordinatorEntity[AppHealth], SensorEntity):
    """Expose local app health without copying raw sensor entities."""

    _attr_has_entity_name = True
    _attr_name = "App availability"

    def __init__(
        self,
        coordinator: CultivationAssistantCoordinator,
        entry_id: str,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{entry_id}_app_availability"

    @property
    def native_value(self) -> str:
        """Return the health state reported by the app."""
        return self.coordinator.data.status

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """Expose only compact diagnostic metadata."""
        health: AppHealth = self.coordinator.data
        return {"app_version": health.version}
