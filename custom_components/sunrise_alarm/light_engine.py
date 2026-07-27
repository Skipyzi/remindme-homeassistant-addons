"""Capability-aware Home Assistant light output."""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final

from homeassistant.components.light import (
    ATTR_BRIGHTNESS_PCT,
    ATTR_COLOR_TEMP_KELVIN,
    ATTR_MAX_COLOR_TEMP_KELVIN,
    ATTR_MIN_COLOR_TEMP_KELVIN,
    ATTR_RGB_COLOR,
    ATTR_SUPPORTED_COLOR_MODES,
)
from homeassistant.components.light.const import DOMAIN as LIGHT_DOMAIN
from homeassistant.components.light.const import ColorMode
from homeassistant.const import (
    ATTR_ENTITY_ID,
    SERVICE_TURN_ON,
    STATE_OFF,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
)
from homeassistant.core import Context, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.state import async_reproduce_state

from .ramp import brightness_at, kelvin_at, kelvin_to_rgb

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Iterable

    from homeassistant.core import Event, EventStateChangedData, HomeAssistant, State

    from .models import LightRampConfig

_LOGGER = logging.getLogger(__name__)
_CONTEXT_HISTORY: Final = 512
_RGB_MODES: Final = frozenset(
    {
        ColorMode.HS,
        ColorMode.RGB,
        ColorMode.RGBW,
        ColorMode.RGBWW,
        ColorMode.XY,
    }
)


@dataclass(frozen=True, slots=True)
class LightStepResult:
    """Result of one independently dispatched light step."""

    succeeded: tuple[str, ...]
    failed: tuple[str, ...]
    degraded: bool


class LightEngine:
    """Apply one ramp step to heterogeneous Home Assistant lights."""

    def __init__(self, hass: HomeAssistant) -> None:
        """Initialize the light engine."""
        self.hass = hass
        self._context_ids: deque[str] = deque(maxlen=_CONTEXT_HISTORY)

    async def async_apply(
        self,
        config: LightRampConfig,
        progress: float,
        parent_context: Context,
    ) -> LightStepResult:
        """Apply current absolute ramp progress to each configured light."""
        succeeded: list[str] = []
        failed: list[str] = []

        for entity_id in config.entity_ids:
            state = self.hass.states.get(entity_id)
            if state is None or state.state in {STATE_UNAVAILABLE, STATE_UNKNOWN}:
                failed.append(entity_id)
                continue

            data = self._service_data(state, config, progress)
            context = Context(parent_id=parent_context.id)
            self._remember_context(context)
            try:
                await self.hass.services.async_call(
                    LIGHT_DOMAIN,
                    SERVICE_TURN_ON,
                    data,
                    blocking=True,
                    context=context,
                )
            except HomeAssistantError as err:
                _LOGGER.warning("Unable to update %s: %s", entity_id, err)
                failed.append(entity_id)
            else:
                succeeded.append(entity_id)

        return LightStepResult(
            succeeded=tuple(succeeded),
            failed=tuple(failed),
            degraded=not succeeded,
        )

    def _service_data(
        self,
        state: State,
        config: LightRampConfig,
        progress: float,
    ) -> dict[str, Any]:
        """Build a capability-filtered service payload."""
        data: dict[str, Any] = {ATTR_ENTITY_ID: state.entity_id}
        modes = frozenset(state.attributes.get(ATTR_SUPPORTED_COLOR_MODES, ()))
        if modes == {ColorMode.ONOFF} or not modes:
            return data

        data[ATTR_BRIGHTNESS_PCT] = brightness_at(config, progress)
        target_kelvin = kelvin_at(config, progress)
        if ColorMode.COLOR_TEMP in modes:
            minimum = int(
                state.attributes.get(ATTR_MIN_COLOR_TEMP_KELVIN, target_kelvin)
            )
            maximum = int(
                state.attributes.get(ATTR_MAX_COLOR_TEMP_KELVIN, target_kelvin)
            )
            data[ATTR_COLOR_TEMP_KELVIN] = max(minimum, min(target_kelvin, maximum))
        elif modes & _RGB_MODES:
            data[ATTR_RGB_COLOR] = kelvin_to_rgb(target_kelvin)
        return data

    @callback
    def async_snapshot(self, entity_ids: Iterable[str]) -> list[State]:
        """Snapshot currently existing selected light states."""
        return [
            state
            for entity_id in entity_ids
            if (state := self.hass.states.get(entity_id)) is not None
        ]

    async def async_restore(self, states: Iterable[State], context: Context) -> None:
        """Restore a preview snapshot through Home Assistant reproduction."""
        state_list = list(states)
        self._remember_context(context)
        await async_reproduce_state(self.hass, state_list, context=context)

    @callback
    def async_start_manual_off_monitor(
        self,
        entity_ids: tuple[str, ...],
        action: Callable[[], Awaitable[None]],
    ) -> Callable[[], None]:
        """Call an action after an external change leaves all lights off."""
        fired = False

        async def state_changed(event: Event[EventStateChangedData]) -> None:
            nonlocal fired
            if fired or self.is_own_context(event.context.id):
                return
            if all(
                (state := self.hass.states.get(entity_id)) is not None
                and state.state == STATE_OFF
                for entity_id in entity_ids
            ):
                fired = True
                await action()

        return async_track_state_change_event(self.hass, entity_ids, state_changed)

    @callback
    def is_own_context(self, context_id: str | None) -> bool:
        """Return whether a state change originated from this engine."""
        return context_id is not None and context_id in self._context_ids

    @callback
    def _remember_context(self, context: Context) -> None:
        """Remember an issued service context for manual-change filtering."""
        self._context_ids.append(context.id)
