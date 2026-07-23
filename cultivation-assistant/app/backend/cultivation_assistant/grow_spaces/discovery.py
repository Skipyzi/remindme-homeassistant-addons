"""Role-filtered discovery over the current Home Assistant entity cache."""

from collections.abc import Mapping
from dataclasses import dataclass

from cultivation_assistant.grow_spaces.roles import get_role_definition
from cultivation_assistant.grow_spaces.schemas import EntityCandidate
from cultivation_assistant.grow_spaces.units import Compatibility, classify_unit
from cultivation_assistant.home_assistant.state_cache import (
    EntityState,
    EntityStateCache,
)


@dataclass(frozen=True, slots=True)
class _RankedCandidate:
    candidate: EntityCandidate
    score: tuple[int, int, int, str, str]


class EntityDiscoveryService:
    """Suggest cached entities that can safely satisfy a semantic role."""

    def __init__(self, state_cache: EntityStateCache) -> None:
        self._state_cache = state_cache

    def suggest(self, role: str) -> list[EntityCandidate]:
        """Return deterministic compatible suggestions for one role."""
        definition = get_role_definition(role)
        ranked: list[_RankedCandidate] = []
        for entity_state in self._state_cache.values():
            candidate = self.assess(entity_state, role)
            if candidate is None:
                continue
            friendly = candidate.friendly_name.casefold()
            hints = sum(hint in friendly for hint in definition.name_hints)
            compatibility_rank = {
                Compatibility.COMPATIBLE: 0,
                Compatibility.CONVERTIBLE: 1,
                Compatibility.UNKNOWN: 2,
                Compatibility.INCOMPATIBLE: 3,
            }[candidate.compatibility]
            device_rank = (
                0
                if candidate.device_class is not None
                and candidate.device_class in definition.device_classes
                else 1
            )
            ranked.append(
                _RankedCandidate(
                    candidate=candidate,
                    score=(
                        compatibility_rank,
                        device_rank,
                        -hints,
                        friendly,
                        candidate.entity_id,
                    ),
                )
            )
        ranked.sort(key=lambda item: item.score)
        return [item.candidate for item in ranked]

    @staticmethod
    def assess(entity_state: EntityState, role: str) -> EntityCandidate | None:
        """Assess one known entity for role compatibility."""
        definition = get_role_definition(role)
        domain = entity_state.entity_id.partition(".")[0]
        if domain not in definition.domains:
            return None

        device_class = _string_attribute(entity_state.attributes, "device_class")
        if (
            device_class is not None
            and definition.device_classes
            and device_class not in definition.device_classes
        ):
            return None

        source_unit = _string_attribute(entity_state.attributes, "unit_of_measurement")
        unit_result = classify_unit(role, source_unit)
        if unit_result.compatibility is Compatibility.INCOMPATIBLE:
            return None

        friendly_name = (
            _string_attribute(entity_state.attributes, "friendly_name") or entity_state.entity_id
        )
        explanation = {
            Compatibility.COMPATIBLE: "Device class and unit match this role.",
            Compatibility.CONVERTIBLE: (
                f"Values will be converted from {unit_result.source_unit} "
                f"to {unit_result.normalized_unit}."
            ),
            Compatibility.UNKNOWN: "Unit metadata is unavailable; verify this entity manually.",
            Compatibility.INCOMPATIBLE: "Entity metadata is incompatible.",
        }[unit_result.compatibility]
        return EntityCandidate(
            entity_id=entity_state.entity_id,
            friendly_name=friendly_name,
            domain=domain,
            device_class=device_class,
            source_unit=unit_result.source_unit,
            current_state=entity_state.state,
            last_updated=entity_state.last_updated,
            available=entity_state.state.casefold() not in {"unavailable", "unknown"},
            compatibility=unit_result.compatibility,
            explanation=explanation,
        )


def _string_attribute(attributes: Mapping[str, object], key: str) -> str | None:
    value = attributes.get(key)
    if value is None:
        return None
    return str(value)
