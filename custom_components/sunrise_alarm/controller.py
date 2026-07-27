"""State machine and orchestration for one Sunrise Alarm."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import replace
from datetime import timedelta
from typing import TYPE_CHECKING, Protocol
from uuid import uuid4

from homeassistant.core import Context, callback

from .models import AlarmConfig, AlarmOccurrence, AlarmState
from .ramp import effective_interval
from .schedule import next_occurrence
from .storage import RecoveryRecord

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Coroutine
    from datetime import datetime
    from typing import Any

    from homeassistant.core import State

    from .light_engine import LightStepResult

_LOGGER = logging.getLogger(__name__)
_PREVIEW_STEP_SECONDS = 10.0
_RECOVERY_GRACE = timedelta(minutes=10)


class RuntimePort(Protocol):
    """Runtime operations required by the controller."""

    def now(self) -> datetime:
        """Return current aware time."""

    def call_at(
        self,
        when: datetime,
        action: Callable[[], Awaitable[None]],
    ) -> Callable[[], None]:
        """Schedule an action."""

    def create_task(
        self,
        coroutine: Coroutine[Any, Any, None],
        name: str,
    ) -> asyncio.Task[None]:
        """Create a task."""

    async def sleep(self, seconds: float) -> None:
        """Sleep asynchronously."""


class LightEnginePort(Protocol):
    """Light operations required by the controller."""

    async def async_apply(
        self,
        config: Any,
        progress: float,
        parent_context: Context,
    ) -> LightStepResult:
        """Apply progress."""

    def async_snapshot(self, entity_ids: tuple[str, ...]) -> list[State]:
        """Snapshot lights."""

    async def async_restore(self, states: list[State], context: Context) -> None:
        """Restore lights."""

    def async_start_manual_off_monitor(
        self,
        entity_ids: tuple[str, ...],
        action: Callable[[], Awaitable[None]],
    ) -> Callable[[], None]:
        """Monitor external all-off changes."""


class StorePort(Protocol):
    """Persistence operations required by the controller."""

    async def async_load(self) -> RecoveryRecord | None:
        """Load recovery data."""

    async def async_save(self, record: RecoveryRecord) -> None:
        """Save recovery data."""

    async def async_clear(self) -> None:
        """Clear recovery data."""


class SunriseAlarmController:
    """Coordinate one configured sunrise alarm."""

    def __init__(
        self,
        config: AlarmConfig,
        runtime: RuntimePort,
        light_engine: LightEnginePort,
        store: StorePort,
    ) -> None:
        """Initialize controller dependencies and idle state."""
        self.config = config
        self._runtime = runtime
        self._light_engine = light_engine
        self._store = store
        self._state = AlarmState.DISABLED
        self._next_occurrence: AlarmOccurrence | None = None
        self._active_occurrence: AlarmOccurrence | None = None
        self._generation = uuid4().hex
        self._callbacks: list[Callable[[], None]] = []
        self._active_task: asyncio.Task[None] | None = None
        self._preview_task: asyncio.Task[None] | None = None
        self._manual_off_cancel: Callable[[], None] | None = None
        self._skip_occurrence_id: str | None = None
        self._skip_wake_time: datetime | None = None
        self._listeners: set[Callable[[], None]] = set()
        self._warnings: list[str] = []
        self._last_outcome: str | None = None
        self._shutdown = False

    @property
    def state(self) -> AlarmState:
        """Return current operational state."""
        return self._state

    @property
    def next_occurrence(self) -> AlarmOccurrence | None:
        """Return the next calculated occurrence."""
        return self._next_occurrence

    @property
    def is_active(self) -> bool:
        """Return whether lights are currently controlled."""
        return self._state in {AlarmState.SUNRISE, AlarmState.PREVIEWING}

    @property
    def available(self) -> bool:
        """Return whether the controller accepts work."""
        return not self._shutdown

    @property
    def last_outcome(self) -> str | None:
        """Return the most recent occurrence outcome."""
        return self._last_outcome

    @property
    def warnings(self) -> tuple[str, ...]:
        """Return recent non-fatal warnings."""
        return tuple(self._warnings)

    @callback
    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Register an entity update listener."""
        self._listeners.add(listener)

        def remove_listener() -> None:
            self._listeners.discard(listener)

        return remove_listener

    async def async_initialize(self) -> None:
        """Initialize scheduling and recover an interrupted occurrence."""
        if self._shutdown:
            return
        record = await self._store.async_load()
        if record is None:
            await self._async_recalculate()
            return

        now = self._runtime.now()
        if record.skip_wake_time is not None and record.skip_wake_time > now:
            self._skip_occurrence_id = record.skip_occurrence_id
            self._skip_wake_time = record.skip_wake_time

        if (
            record.occurrence_id is None
            or record.wake_time is None
            or record.sunrise_start is None
            or record.phase != AlarmState.SUNRISE
        ):
            await self._async_recalculate()
            return

        occurrence = AlarmOccurrence(
            record.occurrence_id,
            record.wake_time,
            record.sunrise_start,
        )
        if occurrence.sunrise_start <= now < occurrence.wake_time:
            self._generation = uuid4().hex
            await self._async_start_occurrence(occurrence)
            return
        if occurrence.wake_time <= now <= occurrence.wake_time + _RECOVERY_GRACE:
            result = await self._light_engine.async_apply(
                self.config.ramp,
                1.0,
                Context(),
            )
            self._last_outcome = "degraded" if result.degraded else "recovered"
            await self._store.async_clear()
            await self._async_recalculate()
            return
        if now > occurrence.wake_time + _RECOVERY_GRACE:
            self._last_outcome = "missed"
            await self._store.async_clear()
        await self._async_recalculate()

    async def async_apply_config(self, config: AlarmConfig) -> None:
        """Apply complete replacement configuration."""
        if self._shutdown:
            return
        self.config = config
        if not config.enabled:
            await self._async_cancel_active()
        await self._async_recalculate()

    async def async_set_enabled(self, *, enabled: bool) -> None:
        """Enable or disable this alarm."""
        await self.async_apply_config(replace(self.config, enabled=enabled))

    async def async_stop(self, reason: str = "user") -> None:
        """Stop active work and retain the recurring schedule."""
        if self._shutdown:
            return
        await self._async_cancel_active()
        self._last_outcome = reason
        await self._store.async_clear()
        await self._async_recalculate()

    async def async_skip_next(self) -> None:
        """Skip the exact currently calculated occurrence."""
        if self._shutdown or self._next_occurrence is None:
            return
        self._skip_occurrence_id = self._next_occurrence.occurrence_id
        self._skip_wake_time = self._next_occurrence.wake_time
        await self._async_recalculate()
        await self._async_persist(None)

    async def async_clear_skip(self) -> None:
        """Clear a pending skip target."""
        if self._shutdown:
            return
        self._skip_occurrence_id = None
        self._skip_wake_time = None
        await self._async_recalculate()
        await self._async_persist(None)

    async def async_preview(self, duration: int = 60) -> None:
        """Start an isolated shortened preview."""
        if self._shutdown or self.is_active or duration <= 0:
            return
        self._preview_task = self._runtime.create_task(
            self._async_run_preview(duration),
            "preview",
        )

    async def async_shutdown(self) -> None:
        """Cancel all callbacks and tasks permanently."""
        if self._shutdown:
            return
        self._shutdown = True
        self._generation = uuid4().hex
        self._cancel_callbacks()
        await self._async_cancel_task(self._active_task)
        await self._async_cancel_task(self._preview_task)
        self._cancel_manual_off_monitor()
        self._active_task = None
        self._preview_task = None
        self._notify_listeners()

    async def _async_recalculate(self) -> None:
        """Replace future callbacks from current configuration."""
        self._generation = uuid4().hex
        self._cancel_callbacks()
        if not self.config.enabled:
            self._next_occurrence = None
            self._state = AlarmState.DISABLED
            self._notify_listeners()
            return

        occurrence = next_occurrence(
            self._runtime.now(),
            self.config.schedule,
            self.config.ramp.duration,
            self._skip_occurrence_id,
        )
        self._next_occurrence = occurrence
        self._state = AlarmState.SCHEDULED
        generation = self._generation

        async def start() -> None:
            if generation != self._generation or self._shutdown:
                return
            await self._async_start_occurrence(occurrence)

        self._callbacks.append(self._runtime.call_at(occurrence.sunrise_start, start))
        if self._skip_wake_time is not None:

            async def clear_skip() -> None:
                if generation != self._generation or self._shutdown:
                    return
                self._skip_occurrence_id = None
                self._skip_wake_time = None
                await self._async_recalculate()
                await self._async_persist(None)

            self._callbacks.append(
                self._runtime.call_at(self._skip_wake_time, clear_skip)
            )
        self._notify_listeners()

    async def _async_start_occurrence(self, occurrence: AlarmOccurrence) -> None:
        """Start one normal sunrise ramp."""
        if self._preview_task is not None:
            await self._async_cancel_task(self._preview_task)
            self._preview_task = None
        self._active_occurrence = occurrence
        self._state = AlarmState.SUNRISE
        if self.config.stop_on_manual_off:

            async def stop_for_manual_off() -> None:
                await self.async_stop("manual_off")

            self._manual_off_cancel = self._light_engine.async_start_manual_off_monitor(
                self.config.ramp.entity_ids,
                stop_for_manual_off,
            )
        await self._async_persist(occurrence)
        self._active_task = self._runtime.create_task(
            self._async_run_occurrence(occurrence, self._generation),
            "sunrise",
        )
        self._notify_listeners()

    async def _async_run_occurrence(
        self,
        occurrence: AlarmOccurrence,
        generation: str,
    ) -> None:
        """Run an absolute-time stepped light ramp."""
        context = Context()
        try:
            while generation == self._generation and not self._shutdown:
                now = self._runtime.now()
                total = (
                    occurrence.wake_time - occurrence.sunrise_start
                ).total_seconds()
                progress = (now - occurrence.sunrise_start).total_seconds() / total
                bounded = max(0.0, min(progress, 1.0))
                result = await self._light_engine.async_apply(
                    self.config.ramp,
                    bounded,
                    context,
                )
                if result.failed:
                    self._warnings = list(result.failed)
                if bounded >= 1.0:
                    self._last_outcome = "degraded" if result.degraded else "completed"
                    self._cancel_manual_off_monitor()
                    self._active_occurrence = None
                    self._active_task = None
                    await self._store.async_clear()
                    await self._async_recalculate()
                    return
                remaining = (occurrence.wake_time - now).total_seconds()
                interval = effective_interval(
                    self.config.ramp.duration,
                    self.config.ramp.update_interval,
                )
                await self._runtime.sleep(min(interval, remaining))
        except asyncio.CancelledError:
            raise
        except Exception as err:
            _LOGGER.exception("Sunrise occurrence failed")
            self._warnings.append(str(err))
            self._state = AlarmState.ERROR
            self._notify_listeners()

    async def _async_run_preview(self, duration: int) -> None:
        """Run and restore one isolated preview."""
        snapshot = self._light_engine.async_snapshot(self.config.ramp.entity_ids)
        context = Context()
        started = self._runtime.now()
        self._state = AlarmState.PREVIEWING
        self._notify_listeners()
        try:
            while not self._shutdown:
                elapsed = (self._runtime.now() - started).total_seconds()
                progress = max(0.0, min(elapsed / duration, 1.0))
                await self._light_engine.async_apply(
                    self.config.ramp,
                    progress,
                    context,
                )
                if progress >= 1.0:
                    return
                await self._runtime.sleep(
                    min(_PREVIEW_STEP_SECONDS, duration - elapsed)
                )
        finally:
            await self._light_engine.async_restore(snapshot, context)
            self._preview_task = None
            if not self._shutdown:
                self._state = AlarmState.SCHEDULED
                self._notify_listeners()

    async def _async_cancel_active(self) -> None:
        """Cancel normal and preview tasks."""
        await self._async_cancel_task(self._active_task)
        await self._async_cancel_task(self._preview_task)
        self._cancel_manual_off_monitor()
        self._active_task = None
        self._preview_task = None
        self._active_occurrence = None

    def _cancel_manual_off_monitor(self) -> None:
        """Remove an active manual-off state listener."""
        if self._manual_off_cancel is not None:
            self._manual_off_cancel()
            self._manual_off_cancel = None

    @staticmethod
    async def _async_cancel_task(task: asyncio.Task[None] | None) -> None:
        """Cancel and await a task without leaking cancellation."""
        if task is None or task.done():
            return
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    def _cancel_callbacks(self) -> None:
        """Cancel all registered absolute callbacks."""
        for cancel in self._callbacks:
            cancel()
        self._callbacks.clear()

    async def _async_persist(self, occurrence: AlarmOccurrence | None) -> None:
        """Persist minimal active and skip state."""
        await self._store.async_save(
            RecoveryRecord(
                occurrence_id=occurrence.occurrence_id if occurrence else None,
                wake_time=occurrence.wake_time if occurrence else None,
                sunrise_start=occurrence.sunrise_start if occurrence else None,
                phase=self._state if occurrence else None,
                skip_occurrence_id=self._skip_occurrence_id,
                skip_wake_time=self._skip_wake_time,
                last_successful=None,
                last_missed=None,
            )
        )

    @callback
    def _notify_listeners(self) -> None:
        """Notify listeners while isolating their failures."""
        for listener in tuple(self._listeners):
            try:
                listener()
            except Exception:
                _LOGGER.exception("Sunrise Alarm listener failed")
