# pyright: reportMissingImports=false
"""Health coordinator for the Cultivation Assistant app."""

import logging
from datetime import timedelta

from aiohttp import ClientError
from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import AppHealth, CultivationAssistantApi, InvalidAppResponse
from .const import DOMAIN


class CultivationAssistantCoordinator(DataUpdateCoordinator[AppHealth]):
    """Poll app health without duplicating raw cultivation entities."""

    def __init__(self, hass: HomeAssistant, api: CultivationAssistantApi) -> None:
        super().__init__(
            hass,
            logger=logging.getLogger(__name__),
            name=DOMAIN,
            update_interval=timedelta(seconds=30),
        )
        self.api = api

    async def _async_update_data(self) -> AppHealth:
        try:
            return await self.api.health()
        except (ClientError, TimeoutError, InvalidAppResponse) as exc:
            raise UpdateFailed(f"Cultivation Assistant health check failed: {exc}") from exc
