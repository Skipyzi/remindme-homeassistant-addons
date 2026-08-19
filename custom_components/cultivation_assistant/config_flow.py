# pyright: reportMissingImports=false, reportCallIssue=false, reportGeneralTypeIssues=false
"""Configuration flow for the local Cultivation Assistant app."""

from typing import Any

import voluptuous as vol
from aiohttp import ClientError
from homeassistant import config_entries
from homeassistant.const import CONF_URL
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import CultivationAssistantApi, InvalidAppResponse
from .const import DEFAULT_APP_URL, DOMAIN


class CultivationAssistantConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure and validate a local app endpoint."""

    VERSION = 1

    async def async_step_user(
        self,
        user_input: dict[str, Any] | None = None,
    ) -> config_entries.ConfigFlowResult:
        """Handle URL configuration and app-health validation."""
        errors: dict[str, str] = {}
        if user_input is not None:
            url = str(user_input[CONF_URL]).rstrip("/")
            api = CultivationAssistantApi(async_get_clientsession(self.hass), url)
            try:
                health = await api.health()
            except (ClientError, TimeoutError, InvalidAppResponse):
                errors["base"] = "cannot_connect"
            else:
                await self.async_set_unique_id(url)
                self._abort_if_unique_id_configured()
                return self.async_create_entry(
                    title=f"Cultivation Assistant {health.version}",
                    data={CONF_URL: url},
                )

        schema = vol.Schema(
            {
                vol.Required(
                    CONF_URL,
                    default=(user_input or {}).get(CONF_URL, DEFAULT_APP_URL),
                ): str
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)
