"""Tests for Sunrise Alarm controller orchestration."""

from __future__ import annotations

import asyncio
from dataclasses import replace
from datetime import UTC, datetime, time, timedelta
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo

from homeassistant.core import Context

from custom_components.sunrise_alarm.controller import SunriseAlarmController
from custom_components.sunrise_alarm.light_engine import LightStepResult
from custom_components.sunrise_alarm.models import (
    AlarmConfig,
    AlarmState,
    FixedScheduleConfig,
    LightRampConfig,
    RampCurve,
)
from custom_components.sunrise_alarm.storage import RecoveryRecord

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from homeassistant.core import State


class FakeRuntime:
    """Deterministic controller runtime."""

    def __init__(self, now: datetime) -> None:
        self.current = now
        self.callbacks: list[tuple[datetime, Callable[[], Awaitable[None]], bool]] = []
        self.tasks: list[asyncio.Task[None]] = []

    def now(self) -> datetime:
        return self.current

    def call_at(
        self, when: datetime, action: Callable[[], Awaitable[None]]
    ) -> Callable[[], None]:
        index = len(self.callbacks)
        self.callbacks.append((when, action, False))

        def cancel() -> None:
            scheduled_when, scheduled_action, _cancelled = self.callbacks[index]
            self.callbacks[index] = (scheduled_when, scheduled_action, True)

        return cancel

    def create_task(self, coroutine: Any, name: str) -> asyncio.Task[None]:
        del name
        task = asyncio.create_task(coroutine)
        self.tasks.append(task)
        return task

    async def sleep(self, seconds: float) -> None:
        self.current += timedelta(seconds=seconds)
        await asyncio.sleep(0)

    async def fire(self, index: int) -> None:
        when, action, cancelled = self.callbacks[index]
        assert not cancelled
        self.current = when
        await action()
        await self.drain()

    async def drain(self) -> None:
        while any(not task.done() for task in self.tasks):
            await asyncio.sleep(0)


class FakeLightEngine:
    """Record controller light interactions."""

    def __init__(self) -> None:
        self.progress: list[float] = []
        self.restored = 0
        self.monitor_started = 0
        self.monitor_cancelled = 0

    async def async_apply(
        self, config: LightRampConfig, progress: float, context: Context
    ) -> LightStepResult:
        del config, context
        self.progress.append(progress)
        return LightStepResult(("light.bed",), (), False)

    def async_snapshot(self, entity_ids: tuple[str, ...]) -> list[State]:
        del entity_ids
        return []

    async def async_restore(self, states: list[State], context: Context) -> None:
        del states, context
        self.restored += 1

    def async_start_manual_off_monitor(
        self,
        entity_ids: tuple[str, ...],
        action: Callable[[], Awaitable[None]],
    ) -> Callable[[], None]:
        del entity_ids, action
        self.monitor_started += 1

        def cancel() -> None:
            self.monitor_cancelled += 1

        return cancel


class FakeStore:
    """Record persisted recovery values."""

    def __init__(self, record: RecoveryRecord | None = None) -> None:
        self.record = record
        self.records: list[object] = []

    async def async_load(self) -> RecoveryRecord | None:
        return self.record

    async def async_save(self, record: object) -> None:
        self.records.append(record)

    async def async_clear(self) -> None:
        self.records.clear()


def alarm_config(
    *, duration: int = 30, stop_on_manual_off: bool = False
) -> AlarmConfig:
    """Build a short deterministic alarm configuration."""
    zone = ZoneInfo("Europe/Berlin")
    return AlarmConfig(
        alarm_id="alarm-1",
        name="Bedroom",
        area_id=None,
        provider="fixed_schedule",
        schedule=FixedScheduleConfig(time(7), frozenset({0, 1, 2, 3, 4}), zone),
        ramp=LightRampConfig(
            ("light.bed",),
            timedelta(seconds=duration),
            1,
            100,
            2200,
            4000,
            RampCurve.LINEAR,
            timedelta(seconds=10),
        ),
        stop_on_manual_off=stop_on_manual_off,
        enabled=True,
    )


def build_controller(
    *,
    now: datetime | None = None,
    record: RecoveryRecord | None = None,
) -> tuple[SunriseAlarmController, FakeRuntime, FakeLightEngine, FakeStore]:
    """Create a controller around Monday's occurrence."""
    runtime = FakeRuntime(now or datetime(2026, 7, 27, 4, 0, tzinfo=UTC))
    lights = FakeLightEngine()
    store = FakeStore(record)
    controller = SunriseAlarmController(alarm_config(), runtime, lights, store)
    return controller, runtime, lights, store


async def test_initialize_schedules_next_occurrence() -> None:
    """Enabled initialization calculates and schedules sunrise start."""
    controller, runtime, _lights, _store = build_controller()

    await controller.async_initialize()

    assert controller.state is AlarmState.SCHEDULED
    assert controller.next_occurrence is not None
    assert len(runtime.callbacks) == 1


async def test_sunrise_uses_absolute_progress_and_reschedules() -> None:
    """A due occurrence ramps to one and schedules the next day."""
    controller, runtime, lights, _store = build_controller()
    await controller.async_initialize()

    await runtime.fire(0)

    assert lights.progress[0] == 0.0
    assert lights.progress[-1] == 1.0
    assert controller.state is AlarmState.SCHEDULED
    assert controller.last_outcome == "completed"
    assert controller.next_occurrence is not None
    assert controller.next_occurrence.wake_time.day == 28


async def test_manual_off_monitor_lives_only_for_active_occurrence() -> None:
    """Configured manual-off monitoring is registered and always removed."""
    runtime = FakeRuntime(datetime(2026, 7, 27, 4, 0, tzinfo=UTC))
    lights = FakeLightEngine()
    controller = SunriseAlarmController(
        alarm_config(stop_on_manual_off=True), runtime, lights, FakeStore()
    )
    await controller.async_initialize()

    await runtime.fire(0)

    assert lights.monitor_started == 1
    assert lights.monitor_cancelled == 1


async def test_stale_callback_cannot_start_replaced_schedule() -> None:
    """A callback captured before recalculation becomes inert."""
    controller, runtime, lights, _store = build_controller()
    await controller.async_initialize()
    stale_action = runtime.callbacks[0][1]

    await controller.async_apply_config(replace(alarm_config(), enabled=False))
    await stale_action()

    assert controller.state is AlarmState.DISABLED
    assert lights.progress == []


async def test_skip_excludes_exact_occurrence_and_clear_restores_it() -> None:
    """Skip and clear operate on the calculated occurrence identity."""
    controller, _runtime, _lights, _store = build_controller()
    await controller.async_initialize()
    skipped = controller.next_occurrence
    assert skipped is not None

    await controller.async_skip_next()
    assert controller.next_occurrence is not None
    assert controller.next_occurrence.wake_time.day == 28

    await controller.async_clear_skip()
    assert controller.next_occurrence is not None
    assert controller.next_occurrence.occurrence_id == skipped.occurrence_id


async def test_preview_restores_snapshot_without_replacing_schedule() -> None:
    """Preview is isolated and returns to the preserved schedule."""
    controller, runtime, lights, _store = build_controller()
    await controller.async_initialize()
    scheduled = controller.next_occurrence

    await controller.async_preview(duration=20)
    await runtime.drain()

    assert lights.progress[0] == 0.0
    assert lights.progress[-1] == 1.0
    assert lights.restored == 1
    assert controller.state is AlarmState.SCHEDULED
    assert controller.next_occurrence == scheduled


def recovery_record() -> RecoveryRecord:
    """Return a persisted Monday sunrise occurrence."""
    return RecoveryRecord(
        occurrence_id="2026-07-27T05:00:00+00:00",
        wake_time=datetime(2026, 7, 27, 5, 0, tzinfo=UTC),
        sunrise_start=datetime(2026, 7, 27, 4, 59, 30, tzinfo=UTC),
        phase="sunrise",
        skip_occurrence_id=None,
        skip_wake_time=None,
        last_successful=None,
        last_missed=None,
    )


async def test_recovery_resumes_absolute_progress_during_sunrise() -> None:
    """Initialization inside the ramp resumes at current absolute progress."""
    controller, runtime, lights, _store = build_controller(
        now=datetime(2026, 7, 27, 4, 59, 45, tzinfo=UTC),
        record=recovery_record(),
    )

    await controller.async_initialize()
    await runtime.drain()

    assert lights.progress[0] == 0.5


async def test_recovery_inside_grace_applies_final_output() -> None:
    """Initialization shortly after wake applies final output once."""
    controller, runtime, lights, _store = build_controller(
        now=datetime(2026, 7, 27, 5, 5, tzinfo=UTC),
        record=recovery_record(),
    )

    await controller.async_initialize()
    await runtime.drain()

    assert lights.progress == [1.0]
    assert controller.last_outcome == "recovered"


async def test_recovery_outside_grace_marks_missed_without_output() -> None:
    """Initialization after grace never starts a delayed sunrise."""
    controller, _runtime, lights, _store = build_controller(
        now=datetime(2026, 7, 27, 5, 11, tzinfo=UTC),
        record=recovery_record(),
    )

    await controller.async_initialize()

    assert lights.progress == []
    assert controller.last_outcome == "missed"


async def test_shutdown_cancels_callbacks_and_rejects_new_work() -> None:
    """Shutdown removes future work and makes commands inert."""
    controller, runtime, _lights, _store = build_controller()
    await controller.async_initialize()

    await controller.async_shutdown()
    await controller.async_preview()

    assert runtime.callbacks[0][2] is True
    assert controller.available is False
