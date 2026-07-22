"""Idempotent in-memory cache for mapped Home Assistant entity states."""

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, cast


@dataclass(frozen=True, slots=True)
class EntityState:
    """Normalized subset of one Home Assistant state object."""

    entity_id: str
    state: str
    attributes: Mapping[str, Any]
    last_updated: datetime


class EntityStateCache:
    """Keep only the newest known state for each entity."""

    def __init__(self) -> None:
        self._states: dict[str, EntityState] = {}

    def update(self, payload: Mapping[str, Any]) -> bool:
        """Store a state unless an equal or newer event is already present."""
        incoming = self._parse(payload)
        current = self._states.get(incoming.entity_id)
        if current is not None and current.last_updated >= incoming.last_updated:
            return False
        self._states[incoming.entity_id] = incoming
        return True

    def get(self, entity_id: str) -> EntityState:
        """Return a cached entity state or raise KeyError when it was never loaded."""
        return self._states[entity_id]

    def values(self) -> tuple[EntityState, ...]:
        """Return an immutable snapshot of current entity states."""
        return tuple(self._states.values())

    def is_stale(
        self,
        entity_id: str,
        threshold: timedelta,
        *,
        now: datetime | None = None,
    ) -> bool:
        """Return whether an entity has exceeded its configured freshness threshold."""
        reference = now or datetime.now(UTC)
        return reference - self.get(entity_id).last_updated > threshold

    @staticmethod
    def _parse(payload: Mapping[str, Any]) -> EntityState:
        updated = datetime.fromisoformat(str(payload["last_updated"]).replace("Z", "+00:00"))
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=UTC)
        attributes = payload.get("attributes", {})
        if not isinstance(attributes, Mapping):
            raise ValueError("Home Assistant state attributes must be an object")
        typed_attributes = cast(Mapping[object, object], attributes)
        normalized_attributes: dict[str, Any] = {}
        for key, value in typed_attributes.items():
            normalized_attributes[str(key)] = value
        return EntityState(
            entity_id=str(payload["entity_id"]),
            state=str(payload["state"]),
            attributes=normalized_attributes,
            last_updated=updated.astimezone(UTC),
        )
