from datetime import UTC, datetime

from cultivation_assistant.lifecycle.rules import (
    TransitionOrder,
    ordered_current_stage,
    requires_transition_confirmation,
)


def test_backdated_transition_does_not_replace_later_current_stage() -> None:
    transitions = [
        TransitionOrder(
            "t2",
            "flowering",
            datetime(2026, 7, 10, tzinfo=UTC),
            datetime(2026, 7, 10, tzinfo=UTC),
        ),
        TransitionOrder(
            "t1",
            "vegetative",
            datetime(2026, 7, 1, tzinfo=UTC),
            datetime(2026, 7, 12, tzinfo=UTC),
        ),
    ]
    assert ordered_current_stage(transitions) == "flowering"


def test_latest_effective_time_wins_with_created_and_id_tiebreak() -> None:
    moment = datetime(2026, 7, 10, tzinfo=UTC)
    transitions = [
        TransitionOrder("a", "seedling", moment, moment),
        TransitionOrder("b", "vegetative", moment, moment),
    ]
    assert ordered_current_stage(transitions) == "vegetative"


def test_backward_and_skipped_moves_require_confirmation() -> None:
    stages = ["seed", "seedling", "vegetative", "flowering"]
    assert not requires_transition_confirmation(stages, "seedling", "vegetative")
    assert requires_transition_confirmation(stages, "vegetative", "seedling")
    assert requires_transition_confirmation(stages, "seed", "flowering")
