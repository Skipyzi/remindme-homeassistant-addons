"""Redacted diagnostics for the Cultivation Assistant integration."""

from __future__ import annotations

from typing import Any, Protocol


class _HomeAssistant(Protocol):
    data: dict[str, Any]


class _ConfigEntry(Protocol):
    entry_id: str


async def async_get_config_entry_diagnostics(
    hass: _HomeAssistant,
    entry: _ConfigEntry,
) -> dict[str, Any]:
    """Return app health without URL, tokens, entity states, or user records."""
    coordinator = hass.data["cultivation_assistant"][entry.entry_id]
    health = coordinator.data
    return {
        "entry_id": entry.entry_id,
        "app": {
            "available": coordinator.last_update_success,
            "status": health.status,
            "version": health.version,
        },
    }
