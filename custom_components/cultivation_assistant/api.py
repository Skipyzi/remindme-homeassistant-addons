"""Small client primitives for the Cultivation Assistant app API."""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, cast


class InvalidAppResponse(ValueError):
    """Raised when the app health response does not match its public contract."""


@dataclass(frozen=True, slots=True)
class AppHealth:
    """Availability information returned by the local app."""

    status: str
    version: str


class CultivationAssistantApi:
    """Query the local app using Home Assistant's managed HTTP session."""

    def __init__(self, session: Any, base_url: str) -> None:
        self._session = session
        self._base_url = base_url.rstrip("/")

    async def health(self) -> AppHealth:
        """Fetch and validate the app health endpoint."""
        async with self._session.get(f"{self._base_url}/api/v1/health") as response:
            response.raise_for_status()
            payload = await response.json()
        if not isinstance(payload, Mapping):
            raise InvalidAppResponse("Health response must be an object")
        typed_payload = cast(Mapping[str, object], payload)
        return parse_health(typed_payload)


def parse_health(payload: Mapping[str, object]) -> AppHealth:
    """Validate the stable health response used by config flow and coordinator."""
    status = payload.get("status")
    version = payload.get("version")
    if (
        not isinstance(status, str)
        or status not in {"healthy", "degraded"}
        or not isinstance(version, str)
    ):
        raise InvalidAppResponse("Health response is missing status or version")
    return AppHealth(status=status, version=version)
