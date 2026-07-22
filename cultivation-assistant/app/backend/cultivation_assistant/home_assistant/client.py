"""Authenticated client for the Supervisor-proxied Home Assistant API."""

from collections.abc import Mapping
from typing import Any, cast

import httpx
from pydantic import SecretStr

from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.runtime import RuntimeStatus


class HomeAssistantConnectionError(RuntimeError):
    """Raised when Home Assistant cannot satisfy a required API request."""


class HomeAssistantClient:
    """Provide the approved REST operations used by domain services."""

    def __init__(
        self,
        *,
        base_url: str,
        token: SecretStr,
        state_cache: EntityStateCache,
        runtime_status: RuntimeStatus,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._token = token
        self._state_cache = state_cache
        self._runtime_status = runtime_status
        self._owns_http_client = http_client is None
        self._http = http_client or httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/",
            timeout=httpx.Timeout(10.0),
        )

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token.get_secret_value()}"}

    async def validate_authentication(self) -> None:
        """Validate the Supervisor token against Home Assistant at startup."""
        try:
            response = await self._http.get("api/", headers=self._headers())
            response.raise_for_status()
        except httpx.HTTPError as exc:
            self._runtime_status.home_assistant_connected = False
            raise HomeAssistantConnectionError("Home Assistant authentication failed") from exc
        self._runtime_status.home_assistant_connected = True

    async def load_initial_states(self) -> int:
        """Load the current Home Assistant state snapshot into the local cache."""
        try:
            response = await self._http.get("api/states", headers=self._headers())
            response.raise_for_status()
        except httpx.HTTPError as exc:
            self._runtime_status.home_assistant_connected = False
            raise HomeAssistantConnectionError("Home Assistant state loading failed") from exc

        payload = response.json()
        if not isinstance(payload, list):
            raise HomeAssistantConnectionError("Home Assistant states response was not a list")
        raw_states = cast(list[object], payload)
        loaded = 0
        for raw_state in raw_states:
            if not isinstance(raw_state, Mapping):
                continue
            state = cast(Mapping[str, Any], raw_state)
            if self._state_cache.update(state):
                loaded += 1
        return loaded

    async def call_service(
        self,
        domain: str,
        service: str,
        data: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        """Call a Home Assistant service and return changed states."""
        path = f"api/services/{domain}/{service}"
        try:
            response = await self._http.post(path, headers=self._headers(), json=dict(data))
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HomeAssistantConnectionError(
                f"Home Assistant service call failed: {domain}.{service}"
            ) from exc
        payload = response.json()
        return cast(list[dict[str, Any]], payload) if isinstance(payload, list) else []

    async def invoke_script(
        self,
        entity_id: str,
        variables: Mapping[str, Any],
    ) -> list[dict[str, Any]]:
        """Invoke a pre-approved Home Assistant script with bounded variables."""
        if not entity_id.startswith("script."):
            raise ValueError("Approved automation target must be a script entity")
        return await self.call_service(
            "script",
            "turn_on",
            {"entity_id": entity_id, "variables": dict(variables)},
        )

    async def fire_event(
        self,
        event_type: str,
        event_data: Mapping[str, Any],
    ) -> None:
        """Publish a cultivation event to the Home Assistant event bus."""
        try:
            response = await self._http.post(
                f"api/events/{event_type}",
                headers=self._headers(),
                json=dict(event_data),
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise HomeAssistantConnectionError(
                f"Home Assistant event publishing failed: {event_type}"
            ) from exc

    async def close(self) -> None:
        """Close the internal HTTP client when this instance created it."""
        if self._owns_http_client:
            await self._http.aclose()
