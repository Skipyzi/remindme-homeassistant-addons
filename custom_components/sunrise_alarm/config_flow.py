"""Config and options flows for Sunrise Alarm."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.config_entries import ConfigFlowResult, OptionsFlow
from homeassistant.core import Context, HomeAssistant, callback
from homeassistant.helpers import config_validation as cv
from homeassistant.util import dt as dt_util

from .const import (
    CONF_ALARM_ID,
    CONF_AREA_ID,
    CONF_CURVE,
    CONF_DURATION_MINUTES,
    CONF_ENABLED,
    CONF_END_BRIGHTNESS,
    CONF_END_KELVIN,
    CONF_LIGHTS,
    CONF_NAME,
    CONF_PROVIDER,
    CONF_START_BRIGHTNESS,
    CONF_START_KELVIN,
    CONF_STOP_ON_MANUAL_OFF,
    CONF_TIMEZONE,
    CONF_UPDATE_INTERVAL,
    CONF_WAKE_TIME,
    CONF_WEEKDAYS,
    DOMAIN,
    PROVIDER_FIXED_SCHEDULE,
)
from .light_engine import LightEngine
from .models import AlarmConfig
from .schedule import next_occurrence

_ACTION = "action"
_ACTION_FINISH = "finish"
_ACTION_PREVIEW = "preview"
_WEEKDAYS = dict(
    enumerate(
        ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
    )
)
_PREVIEW_PROGRESS = (0.0, 0.5, 1.0)


def _schedule_schema(defaults: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_WAKE_TIME, default=defaults.get(CONF_WAKE_TIME, "07:00:00")
            ): str,
            vol.Required(
                CONF_WEEKDAYS, default=defaults.get(CONF_WEEKDAYS, [0, 1, 2, 3, 4])
            ): cv.multi_select(_WEEKDAYS),
            vol.Required(CONF_ENABLED, default=defaults.get(CONF_ENABLED, True)): bool,
        }
    )


def _lights_schema(defaults: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_LIGHTS, default=defaults.get(CONF_LIGHTS, [])): [str],
            vol.Required(
                CONF_DURATION_MINUTES, default=defaults.get(CONF_DURATION_MINUTES, 30)
            ): vol.All(vol.Coerce(int), vol.Range(min=1, max=180)),
            vol.Required(
                CONF_START_BRIGHTNESS, default=defaults.get(CONF_START_BRIGHTNESS, 1)
            ): vol.All(vol.Coerce(int), vol.Range(min=1, max=100)),
            vol.Required(
                CONF_END_BRIGHTNESS, default=defaults.get(CONF_END_BRIGHTNESS, 100)
            ): vol.All(vol.Coerce(int), vol.Range(min=1, max=100)),
            vol.Required(
                CONF_START_KELVIN, default=defaults.get(CONF_START_KELVIN, 2200)
            ): vol.All(vol.Coerce(int), vol.Range(min=1000, max=10000)),
            vol.Required(
                CONF_END_KELVIN, default=defaults.get(CONF_END_KELVIN, 4000)
            ): vol.All(vol.Coerce(int), vol.Range(min=1000, max=10000)),
            vol.Required(
                CONF_CURVE, default=defaults.get(CONF_CURVE, "natural")
            ): vol.In(("linear", "natural")),
            vol.Required(
                CONF_UPDATE_INTERVAL, default=defaults.get(CONF_UPDATE_INTERVAL, 10)
            ): vol.All(vol.Coerce(int), vol.Range(min=5, max=60)),
        }
    )


def _behavior_schema(defaults: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_STOP_ON_MANUAL_OFF,
                default=defaults.get(CONF_STOP_ON_MANUAL_OFF, False),
            ): bool
        }
    )


def _review_schema() -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(_ACTION, default=_ACTION_FINISH): vol.In(
                (_ACTION_FINISH, _ACTION_PREVIEW)
            )
        }
    )


async def async_run_flow_preview(hass: HomeAssistant, config: AlarmConfig) -> None:
    """Run a ten-second setup preview and always restore selected lights."""
    engine = LightEngine(hass)
    states = engine.async_snapshot(config.ramp.entity_ids)
    context = Context()
    try:
        for index, progress in enumerate(_PREVIEW_PROGRESS):
            await engine.async_apply(config.ramp, progress, context)
            if index < len(_PREVIEW_PROGRESS) - 1:
                await asyncio.sleep(5)
    finally:
        await engine.async_restore(states, context)


class _FlowSteps:
    """Shared editable wizard steps."""

    hass: HomeAssistant
    _data: dict[str, Any]
    _options: dict[str, Any]

    if TYPE_CHECKING:

        def async_show_form(  # noqa: PLR0913 - mirrors Home Assistant API
            self,
            *,
            step_id: str | None = None,
            data_schema: vol.Schema | None = None,
            errors: dict[str, str] | None = None,
            description_placeholders: Mapping[str, str] | None = None,
            last_step: bool | None = None,
            preview: str | None = None,
        ) -> ConfigFlowResult:
            """Type contract supplied by ConfigFlow and OptionsFlow."""
            raise NotImplementedError

    async def async_step_schedule(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            if not user_input[CONF_WEEKDAYS]:
                errors[CONF_WEEKDAYS] = "no_weekdays"
            else:
                self._options.update(user_input)
                return await self.async_step_lights()
        return self.async_show_form(
            step_id="schedule",
            data_schema=_schedule_schema(self._options),
            errors=errors,
        )

    async def async_step_lights(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            if not user_input[CONF_LIGHTS]:
                errors[CONF_LIGHTS] = "no_lights"
            elif user_input[CONF_END_BRIGHTNESS] < user_input[CONF_START_BRIGHTNESS]:
                errors[CONF_END_BRIGHTNESS] = "invalid_brightness"
            else:
                self._options.update(user_input)
                return await self.async_step_behavior()
        return self.async_show_form(
            step_id="lights", data_schema=_lights_schema(self._options), errors=errors
        )

    async def async_step_behavior(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            self._options.update(user_input)
            return await self.async_step_review()
        return self.async_show_form(
            step_id="behavior", data_schema=_behavior_schema(self._options)
        )

    async def async_step_review(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        config = AlarmConfig.from_mappings(self._data, self._options)
        occurrence = next_occurrence(
            dt_util.now(), config.schedule, config.ramp.duration
        )
        if user_input is not None:
            if user_input[_ACTION] == _ACTION_PREVIEW:
                await async_run_flow_preview(self.hass, config)
            else:
                return self._finish(config)
        return self.async_show_form(
            step_id="review",
            data_schema=_review_schema(),
            description_placeholders={
                "next_wake": occurrence.wake_time.isoformat(),
                "sunrise_start": occurrence.sunrise_start.isoformat(),
            },
        )

    def _finish(self, config: AlarmConfig) -> ConfigFlowResult:
        raise NotImplementedError


class SunriseAlarmConfigFlow(_FlowSteps, config_entries.ConfigFlow, domain=DOMAIN):
    """Handle initial Sunrise Alarm setup."""

    VERSION = 1

    def __init__(self) -> None:
        """Initialize empty wizard state."""
        self._data = {}
        self._options = {}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Collect alarm identity and timezone."""
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                ZoneInfo(user_input[CONF_TIMEZONE])
            except ZoneInfoNotFoundError:
                errors[CONF_TIMEZONE] = "invalid_timezone"
            else:
                self._data = {
                    CONF_ALARM_ID: uuid4().hex,
                    CONF_NAME: user_input[CONF_NAME],
                    CONF_AREA_ID: user_input.get(CONF_AREA_ID),
                    CONF_PROVIDER: PROVIDER_FIXED_SCHEDULE,
                    CONF_TIMEZONE: user_input[CONF_TIMEZONE],
                }
                return await self.async_step_schedule()
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_NAME): str,
                    vol.Optional(CONF_AREA_ID): str,
                    vol.Required(
                        CONF_TIMEZONE, default=self.hass.config.time_zone
                    ): str,
                }
            ),
            errors=errors,
        )

    def _finish(self, config: AlarmConfig) -> ConfigFlowResult:
        return self.async_create_entry(
            title=config.name, data=self._data, options=self._options
        )

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> SunriseAlarmOptionsFlow:
        """Return the options flow for an existing entry."""
        del config_entry
        return SunriseAlarmOptionsFlow()


class SunriseAlarmOptionsFlow(_FlowSteps, OptionsFlow):
    """Edit Sunrise Alarm options in place."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Start options editing with current values."""
        del user_input
        self._data = dict(self.config_entry.data)
        self._options = dict(self.config_entry.options)
        return await self.async_step_schedule()

    def _finish(self, config: AlarmConfig) -> ConfigFlowResult:
        del config
        return self.async_create_entry(data=self._options)
