"""Home Assistant runtime adapter for Sunrise Alarm controllers."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from homeassistant.helpers.event import async_track_point_in_time
from homeassistant.util import dt as dt_util

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Coroutine
    from datetime import datetime
    from typing import Any

    from homeassistant.core import HomeAssistant


class HomeAssistantRuntime:
    """Expose clock, callback, task, and sleep operations to a controller."""

    def __init__(self, hass: HomeAssistant, entry_id: str) -> None:
        """Initialize the adapter."""
        self._hass = hass
        self._entry_id = entry_id

    def now(self) -> datetime:
        """Return the current aware UTC time."""
        return dt_util.utcnow()

    def call_at(
        self,
        when: datetime,
        action: Callable[[], Awaitable[None]],
    ) -> Callable[[], None]:
        """Schedule one async action at an absolute point in time."""

        async def run_action(_now: datetime) -> None:
            await action()

        return async_track_point_in_time(self._hass, run_action, when)

    def create_task(
        self,
        coroutine: Coroutine[Any, Any, None],
        name: str,
    ) -> asyncio.Task[None]:
        """Create a named Home Assistant task."""
        return self._hass.async_create_task(
            coroutine,
            f"sunrise_alarm_{self._entry_id}_{name}",
        )

    async def sleep(self, seconds: float) -> None:
        """Sleep without blocking Home Assistant's event loop."""
        await asyncio.sleep(seconds)
