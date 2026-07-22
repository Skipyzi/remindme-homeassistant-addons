"""Reconnectable Home Assistant WebSocket state subscription."""

import asyncio
import json
from collections.abc import Generator, Mapping
from typing import Any, cast

from pydantic import SecretStr
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from cultivation_assistant.home_assistant.state_cache import EntityStateCache
from cultivation_assistant.runtime import RuntimeStatus


class HomeAssistantSubscriptionError(RuntimeError):
    """Raised when the Home Assistant WebSocket protocol cannot be established."""


def exponential_backoff(*, initial: float = 1.0, maximum: float = 60.0) -> Generator[float]:
    """Yield bounded exponential reconnection delays."""
    delay = initial
    while True:
        yield delay
        delay = min(delay * 2, maximum)


class HomeAssistantEventSubscriber:
    """Subscribe to state changes and keep the entity cache current."""

    def __init__(
        self,
        *,
        websocket_url: str,
        token: SecretStr,
        state_cache: EntityStateCache,
        runtime_status: RuntimeStatus | None = None,
    ) -> None:
        self._websocket_url = websocket_url
        self._token = token
        self._state_cache = state_cache
        self._runtime_status = runtime_status

    def process_message(self, message: Mapping[str, Any]) -> bool:
        """Process one decoded WebSocket message idempotently."""
        if message.get("type") != "event":
            return False
        raw_event: object = message.get("event")
        if not isinstance(raw_event, Mapping):
            return False
        event = cast(Mapping[str, Any], raw_event)
        if event.get("event_type") != "state_changed":
            return False
        raw_data: object = event.get("data")
        if not isinstance(raw_data, Mapping):
            return False
        data = cast(Mapping[str, Any], raw_data)
        raw_new_state: object = data.get("new_state")
        if not isinstance(raw_new_state, Mapping):
            return False
        new_state = cast(Mapping[str, Any], raw_new_state)
        return self._state_cache.update(new_state)

    async def run_forever(self, stop_event: asyncio.Event) -> None:
        """Reconnect until cancellation or an explicit stop request."""
        delays = exponential_backoff()
        while not stop_event.is_set():
            try:
                await self._subscribe_once(stop_event)
                delays = exponential_backoff()
            except (ConnectionClosed, OSError, HomeAssistantSubscriptionError):
                if self._runtime_status is not None:
                    self._runtime_status.home_assistant_connected = False
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=next(delays))
                except TimeoutError:
                    continue

    async def _subscribe_once(self, stop_event: asyncio.Event) -> None:
        async with connect(self._websocket_url, open_timeout=10) as websocket:
            auth_required = await self._receive_json(websocket)
            if auth_required.get("type") != "auth_required":
                raise HomeAssistantSubscriptionError("Expected Home Assistant authentication")
            await websocket.send(
                json.dumps({"type": "auth", "access_token": self._token.get_secret_value()})
            )
            auth_result = await self._receive_json(websocket)
            if auth_result.get("type") != "auth_ok":
                raise HomeAssistantSubscriptionError(
                    "Home Assistant WebSocket rejected authentication"
                )
            await websocket.send(
                json.dumps({"id": 1, "type": "subscribe_events", "event_type": "state_changed"})
            )
            if self._runtime_status is not None:
                self._runtime_status.home_assistant_connected = True

            while not stop_event.is_set():
                message = await self._receive_json(websocket)
                self.process_message(message)

    @staticmethod
    async def _receive_json(websocket: ClientConnection) -> Mapping[str, Any]:
        raw_message = await websocket.recv()
        if isinstance(raw_message, bytes):
            raw_message = raw_message.decode("utf-8")
        try:
            payload = json.loads(raw_message)
        except (json.JSONDecodeError, TypeError) as exc:
            raise HomeAssistantSubscriptionError(
                "Invalid Home Assistant WebSocket message"
            ) from exc
        if not isinstance(payload, Mapping):
            raise HomeAssistantSubscriptionError(
                "Home Assistant WebSocket message was not an object"
            )
        return cast(Mapping[str, Any], payload)
