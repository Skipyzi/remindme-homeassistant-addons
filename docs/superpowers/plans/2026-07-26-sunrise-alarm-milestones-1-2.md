# Sunrise Alarm Milestones 1–2 Implementation Plan

<!-- markdownlint-disable MD013 -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a HACS-compatible Home Assistant custom integration that runs a
DST-aware weekly sunrise schedule over heterogeneous lights and supports restart
recovery, preview, stop, enable, and skip controls.

**Architecture:** Pure scheduling and ramp calculations live in dependency-free
Python modules. One controller per config entry owns runtime state and delegates
Home Assistant scheduling, persistence, and light calls to narrow adapters.
Entities and actions are command surfaces over that controller, never separate
state owners.

**Tech Stack:** Python 3.14.2, Home Assistant Core 2026.7.4, pytest,
pytest-homeassistant-custom-component, Ruff, mypy, HACS custom-integration
layout.

## Global Constraints

- Integration domain is exactly `sunrise_alarm`.
- Minimum supported Home Assistant Core version is `2026.7.4`.
- Home Assistant is the only schedule source in this implementation slice.
- All wake and occurrence datetimes are timezone-aware.
- Spring DST gaps run at the first valid local time after the requested time.
- Autumn DST repetitions run once using `fold=0`.
- The controller is the sole runtime-state authority for an alarm.
- Each callback verifies the occurrence or execution identifier it captured.
- Ramp progress derives from absolute timestamps, not step counters.
- Unsupported light attributes are never sent.
- Individual light failures never fail the complete occurrence.
- All user-facing strings use translation keys.
- No audio, snooze, external provider, Apple bridge, arbitrary stage, repair, or
  diagnostic placeholder is added.
- Use test-first red-green-refactor cycles and commit after every task.

---

## File Map

### Project and metadata

- `pyproject.toml`: Python baseline, test and quality-tool configuration.
- `hacs.json`: HACS repository metadata.
- `README.md`: installation, setup, behavior, limitations, and reliability note.
- `custom_components/sunrise_alarm/manifest.json`: Home Assistant manifest.
- `custom_components/sunrise_alarm/const.py`: domain constants and option keys.
- `custom_components/sunrise_alarm/strings.json`: source translation strings.
- `custom_components/sunrise_alarm/translations/en.json`: English translation.
- `custom_components/sunrise_alarm/services.yaml`: action UI schemas.

### Domain and runtime

- `custom_components/sunrise_alarm/models.py`: enums and immutable models.
- `custom_components/sunrise_alarm/schedule.py`: weekly and DST calculations.
- `custom_components/sunrise_alarm/ramp.py`: curves and output interpolation.
- `custom_components/sunrise_alarm/storage.py`: versioned recovery records.
- `custom_components/sunrise_alarm/light_engine.py`: capability-aware HA calls.
- `custom_components/sunrise_alarm/controller.py`: state machine and
  orchestration.
- `custom_components/sunrise_alarm/ha_runtime.py`: HA clock, callback, and task
  adapter used by the controller.

### Home Assistant surface

- `custom_components/sunrise_alarm/__init__.py`: config-entry lifecycle and
  action registration.
- `custom_components/sunrise_alarm/config_flow.py`: initial and options flows.
- `custom_components/sunrise_alarm/entity.py`: common device/entity metadata.
- `custom_components/sunrise_alarm/switch.py`: enabled switch.
- `custom_components/sunrise_alarm/sensor.py`: next-alarm and status sensors.
- `custom_components/sunrise_alarm/binary_sensor.py`: active indicator.
- `custom_components/sunrise_alarm/time.py`: wake-time editor.
- `custom_components/sunrise_alarm/number.py`: duration editor.
- `custom_components/sunrise_alarm/button.py`: stop, skip, and preview buttons.

### Tests

- `tests/conftest.py`: custom integration enablement and reusable entry fixture.
- `tests/test_models.py`: mapping validation and serialization.
- `tests/test_schedule.py`: recurrence, weekday, skip, and DST behavior.
- `tests/test_ramp.py`: curves, interpolation, clamping, RGB conversion.
- `tests/test_storage.py`: recovery schema and stale-record handling.
- `tests/test_controller.py`: state transitions and callback safety with fakes.
- `tests/test_light_engine.py`: capability payloads and failure isolation.
- `tests/test_config_flow.py`: initial and options flow behavior.
- `tests/test_init.py`: setup, unload, runtime data, and actions.
- `tests/test_entities.py`: entity state, availability, and commands.
- `tests/test_recovery.py`: restart behavior across occurrence phases.

---

### Task 1: Establish the tested integration skeleton and models

**Files:**

- Create: `pyproject.toml`
- Create: `custom_components/sunrise_alarm/__init__.py`
- Create: `custom_components/sunrise_alarm/manifest.json`
- Create: `custom_components/sunrise_alarm/const.py`
- Create: `custom_components/sunrise_alarm/models.py`
- Create: `tests/conftest.py`
- Create: `tests/test_models.py`

**Interfaces:**

- Produces: `AlarmState`, `RampCurve`, `FixedScheduleConfig`, `LightRampConfig`,
  `AlarmConfig`, `AlarmOccurrence`, and
  `AlarmConfig.from_mappings(data, options)`.
- `AlarmOccurrence.occurrence_id` is the UTC ISO wake timestamp.
- Weekdays use Python's `datetime.weekday()` convention, Monday `0` through
  Sunday `6`.

- [ ] **Step 1: Add the test environment and a failing model test**

Use this project configuration:

```toml
[build-system]
requires = ["setuptools>=78"]
build-backend = "setuptools.build_meta"

[project]
name = "sunrise-alarm"
version = "0.1.0"
requires-python = ">=3.14.2"
dependencies = ["homeassistant==2026.7.4"]

[project.optional-dependencies]
test = [
  "mypy>=1.17",
  "pytest>=8.4",
  "pytest-asyncio>=1.1",
  "pytest-homeassistant-custom-component>=0.13.224",
  "ruff>=0.12",
]

[tool.pytest.ini_options]
asyncio_mode = "auto"
testpaths = ["tests"]

[tool.ruff]
target-version = "py314"
line-length = 88

[tool.ruff.lint]
select = ["ALL"]
ignore = ["ANN401", "D203", "D213", "COM812"]

[tool.mypy]
python_version = "3.14"
strict = true

[tool.setuptools.packages.find]
include = ["custom_components*"]
namespaces = true
```

Create `tests/conftest.py` with an autouse fixture that requests
`enable_custom_integrations`. Install the test environment with:

```bash
python -m pip install -e ".[test]"
```

Create `tests/test_models.py` with tests that call:

```python
from datetime import time

import pytest

from custom_components.sunrise_alarm.models import AlarmConfig, RampCurve


def test_alarm_config_from_mappings() -> None:
    config = AlarmConfig.from_mappings(
        {
            "alarm_id": "alarm-1",
            "name": "Bedroom",
            "area_id": "bedroom",
            "provider": "fixed_schedule",
            "timezone": "Europe/Berlin",
        },
        {
            "wake_time": "07:00:00",
            "weekdays": [0, 1, 2, 3, 4],
            "lights": ["light.left", "light.right"],
            "duration_minutes": 30,
            "start_brightness": 1,
            "end_brightness": 100,
            "start_kelvin": 2200,
            "end_kelvin": 4000,
            "curve": "natural",
            "update_interval": 10,
            "stop_on_manual_off": False,
            "enabled": True,
        },
    )

    assert config.schedule.wake_time == time(7, 0)
    assert config.schedule.weekdays == frozenset({0, 1, 2, 3, 4})
    assert config.ramp.curve is RampCurve.NATURAL


def test_alarm_config_rejects_no_weekdays() -> None:
    data = {
        "alarm_id": "alarm-1",
        "name": "Bedroom",
        "area_id": None,
        "provider": "fixed_schedule",
        "timezone": "Europe/Berlin",
    }
    options = valid_options() | {"weekdays": []}

    with pytest.raises(ValueError, match="weekday"):
        AlarmConfig.from_mappings(data, options)
```

- [ ] **Step 2: Run the model test and verify the import failure**

Run:

```bash
python -m pytest tests/test_models.py -q
```

Expected: collection fails because `models.py` does not exist.

- [ ] **Step 3: Implement constants, manifest, and immutable models**

Use `StrEnum`, frozen slotted dataclasses, `ZoneInfo`, and explicit validation.
The public model shape must be:

```python
class AlarmState(StrEnum):
    DISABLED = "disabled"
    SCHEDULED = "scheduled"
    SUNRISE = "sunrise"
    PREVIEWING = "previewing"
    ERROR = "error"


class RampCurve(StrEnum):
    LINEAR = "linear"
    NATURAL = "natural"


@dataclass(frozen=True, slots=True)
class FixedScheduleConfig:
    wake_time: time
    weekdays: frozenset[int]
    timezone: ZoneInfo


@dataclass(frozen=True, slots=True)
class LightRampConfig:
    entity_ids: tuple[str, ...]
    duration: timedelta
    start_brightness: int
    end_brightness: int
    start_kelvin: int
    end_kelvin: int
    curve: RampCurve
    update_interval: timedelta


@dataclass(frozen=True, slots=True)
class AlarmConfig:
    alarm_id: str
    name: str
    area_id: str | None
    provider: str
    schedule: FixedScheduleConfig
    ramp: LightRampConfig
    stop_on_manual_off: bool
    enabled: bool

    @classmethod
    def from_mappings(
        cls, data: Mapping[str, Any], options: Mapping[str, Any]
    ) -> "AlarmConfig":
        """Parse and validate config-entry mappings."""


@dataclass(frozen=True, slots=True)
class AlarmOccurrence:
    occurrence_id: str
    wake_time: datetime
    sunrise_start: datetime
```

Validation must enforce provider `fixed_schedule`, at least one weekday and
light, weekday range `0..6`, brightness `1..100`, final brightness not below
initial, Kelvin `1000..10000`, interval `5..60` seconds, and positive duration.
Use `datetime.time.fromisoformat()` and `ZoneInfo()` for parsing.

Create the manifest with `config_flow: true`, `integration_type: service`,
`iot_class: calculated`, version `0.1.0`, and no runtime requirements. Keep
`__init__.py` limited to `async_setup` returning `True` until Task 7.

- [ ] **Step 4: Run model tests and quality checks**

Run:

```bash
python -m pytest tests/test_models.py -q
python -m ruff check custom_components tests/test_models.py
python -m mypy custom_components/sunrise_alarm
```

Expected: model tests pass and both quality commands exit `0`.

- [ ] **Step 5: Commit the skeleton**

```bash
git add pyproject.toml custom_components tests/conftest.py tests/test_models.py
git commit -m "feat: scaffold sunrise alarm domain models"
```

---

### Task 2: Implement weekly and DST-aware occurrence calculation

**Files:**

- Create: `custom_components/sunrise_alarm/schedule.py`
- Create: `tests/test_schedule.py`

**Interfaces:**

- Consumes: `FixedScheduleConfig`, `AlarmOccurrence`.
- Produces: `resolve_local_datetime(day, wall_time, timezone) -> datetime`,
  `occurrence_id_for(wake_time) -> str`, and
  `next_occurrence(now, schedule, duration, skip_id=None) -> AlarmOccurrence`.

- [ ] **Step 1: Write failing recurrence and DST tests**

Cover later today, already passed, Friday-to-Monday rollover, skip exclusion,
Europe/Berlin `2026-03-29 02:30` becoming `03:00`, and repeated
`2026-10-25 02:30` using the first offset. Include these exact assertions:

```python
assert spring.wake_time.isoformat() == "2026-03-29T03:00:00+02:00"
assert autumn.wake_time.isoformat() == "2026-10-25T02:30:00+02:00"
assert autumn.wake_time.fold == 0
assert result.sunrise_start == result.wake_time - timedelta(minutes=30)
```

- [ ] **Step 2: Run the schedule tests and verify failure**

```bash
python -m pytest tests/test_schedule.py -q
```

Expected: import fails because `schedule.py` does not exist.

- [ ] **Step 3: Implement candidate validation and recurrence search**

The local-time resolver must construct both folds, round-trip each candidate
through UTC, retain only candidates that reproduce the requested naive wall
time, and choose fold `0`. If neither candidate is valid, advance one second at
a time with a four-hour safety bound and return the first valid wall time.

The recurrence search must inspect at most eight local dates, compare aware
instants, exclude only the exact `skip_id`, and return UTC-derived occurrence
IDs:

```python
def occurrence_id_for(wake_time: datetime) -> str:
    return wake_time.astimezone(UTC).isoformat()
```

Raise `ValueError` for a naive `now` or an impossible configuration rather than
returning a naive result.

- [ ] **Step 4: Run all scheduling tests**

```bash
python -m pytest tests/test_schedule.py -q
python -m ruff check custom_components/sunrise_alarm/schedule.py tests/test_schedule.py
```

Expected: all schedule tests pass and Ruff exits `0`.

- [ ] **Step 5: Commit scheduling**

```bash
git add custom_components/sunrise_alarm/schedule.py tests/test_schedule.py
git commit -m "feat: add DST-aware weekly scheduling"
```

---

### Task 3: Implement deterministic ramp calculations

**Files:**

- Create: `custom_components/sunrise_alarm/ramp.py`
- Create: `tests/test_ramp.py`

**Interfaces:**

- Produces: `clamp_progress`, `curve_value`, `interpolate`,
  `effective_interval`, `brightness_at`, `kelvin_at`, and `kelvin_to_rgb`.
- All functions are pure and return bounded values.

- [ ] **Step 1: Write failing curve and conversion tests**

Test progress below zero and above one, exact endpoints, natural midpoint,
reverse Kelvin direction, update cap, and RGB channel bounds. Required checks:

```python
assert curve_value(RampCurve.LINEAR, 0.5) == 0.5
assert curve_value(RampCurve.NATURAL, 0.5) == pytest.approx(0.5**2.2)
assert brightness_at(config, 0.0) == 1
assert brightness_at(config, 1.0) == 100
assert kelvin_at(config, 0.5) == 3100
assert effective_interval(timedelta(hours=2), timedelta(seconds=5)) == 20.0
assert all(0 <= channel <= 255 for channel in kelvin_to_rgb(2200))
```

- [ ] **Step 2: Verify the ramp tests fail**

```bash
python -m pytest tests/test_ramp.py -q
```

Expected: import fails because `ramp.py` does not exist.

- [ ] **Step 3: Implement the curve pipeline**

Use rounded integer outputs and cap updates with:

```python
def effective_interval(duration: timedelta, requested: timedelta) -> float:
    return max(requested.total_seconds(), duration.total_seconds() / 360)
```

Implement standard logarithmic Kelvin-to-RGB approximation after clamping to
`1000..10000 K`. Clamp each resulting channel to `0..255`. Keep conversion in
this pure module so light-engine tests need no Home Assistant instance.

- [ ] **Step 4: Run ramp tests and quality checks**

```bash
python -m pytest tests/test_ramp.py -q
python -m ruff check custom_components/sunrise_alarm/ramp.py tests/test_ramp.py
```

Expected: all tests pass and Ruff exits `0`.

- [ ] **Step 5: Commit ramp calculations**

```bash
git add custom_components/sunrise_alarm/ramp.py tests/test_ramp.py
git commit -m "feat: add sunrise ramp calculations"
```

---

### Task 4: Add versioned runtime persistence

**Files:**

- Create: `custom_components/sunrise_alarm/storage.py`
- Create: `tests/test_storage.py`

**Interfaces:**

- Produces `RecoveryRecord`, `AlarmStore.async_load()`,
  `AlarmStore.async_save(record)`, and `AlarmStore.async_clear()`.
- Store key is `sunrise_alarm.<entry_id>` and schema version is `1`.

- [ ] **Step 1: Write failing serialization tests**

Test aware timestamp round-trips, missing store, unknown schema version, expired
skip cleanup input, and rejection of naive datetimes. A valid record is:

```python
RecoveryRecord(
    occurrence_id="2026-07-27T05:00:00+00:00",
    wake_time=datetime(2026, 7, 27, 5, tzinfo=UTC),
    sunrise_start=datetime(2026, 7, 27, 4, 30, tzinfo=UTC),
    phase="sunrise",
    skip_occurrence_id=None,
    skip_wake_time=None,
    last_successful=None,
    last_missed=None,
)
```

- [ ] **Step 2: Verify storage tests fail**

```bash
python -m pytest tests/test_storage.py -q
```

Expected: import fails because `storage.py` does not exist.

- [ ] **Step 3: Implement strict record conversion and Store adapter**

Use `homeassistant.helpers.storage.Store[dict[str, Any]]` with version `1`.
Serialize timestamps as ISO 8601 strings and parse with
`datetime.fromisoformat()`. Invalid, naive, or unsupported records log one
warning and return `None`; they never block config-entry setup.

- [ ] **Step 4: Run storage tests**

```bash
python -m pytest tests/test_storage.py -q
python -m ruff check custom_components/sunrise_alarm/storage.py tests/test_storage.py
```

Expected: all storage tests pass and Ruff exits `0`.

- [ ] **Step 5: Commit persistence**

```bash
git add custom_components/sunrise_alarm/storage.py tests/test_storage.py
git commit -m "feat: persist alarm recovery state"
```

---

### Task 5: Build the capability-aware Home Assistant light engine

**Files:**

- Create: `custom_components/sunrise_alarm/light_engine.py`
- Create: `tests/test_light_engine.py`

**Interfaces:**

- Consumes: `LightRampConfig` and ramp functions.
- Produces `LightStepResult(succeeded, failed, degraded)`,
  `LightEngine.async_apply(config, progress, context)`,
  `LightEngine.async_snapshot(entity_ids)`,
  `LightEngine.async_restore(states, context)`, and
  `LightEngine.is_own_context(context_id) -> bool`.

- [ ] **Step 1: Write failing payload and isolation tests**

Create fake HA states for colour-temperature, RGB, brightness-only, on/off-only,
and unavailable lights. Capture `light.turn_on` calls and assert:

```python
assert temp_call[ATTR_COLOR_TEMP_KELVIN] == 2200
assert ATTR_RGB_COLOR not in temp_call
assert ATTR_RGB_COLOR in rgb_call
assert ATTR_COLOR_TEMP_KELVIN not in rgb_call
assert set(brightness_call) == {ATTR_ENTITY_ID, ATTR_BRIGHTNESS_PCT}
assert on_off_call == {ATTR_ENTITY_ID: "light.relay"}
assert result.succeeded == ("light.temp", "light.rgb", "light.dim", "light.relay")
assert result.failed == ("light.missing",)
```

Also prove per-light exceptions do not prevent later calls and restoration uses
`homeassistant.helpers.state.async_reproduce_state`.

- [ ] **Step 2: Verify light-engine tests fail**

```bash
python -m pytest tests/test_light_engine.py -q
```

Expected: import fails because `light_engine.py` does not exist.

- [ ] **Step 3: Implement per-light capability planning and calls**

Read `supported_color_modes`, `min_color_temp_kelvin`, and
`max_color_temp_kelvin` from each current state. Prefer colour temperature, then
RGB, then brightness. Send a separate service call per light with a fresh
`Context`; retain recent context IDs in a bounded deque for manual-change
filtering. Clamp Kelvin to each entity's advertised range.

Catch `HomeAssistantError` and missing/unavailable state independently. Return a
degraded result when no configured light succeeds. Snapshot existing `State`
objects and restore them through:

```python
await async_reproduce_state(self.hass, states, context=context)
```

- [ ] **Step 4: Run light tests and regression tests**

```bash
python -m pytest tests/test_ramp.py tests/test_light_engine.py -q
python -m ruff check custom_components/sunrise_alarm/light_engine.py tests/test_light_engine.py
```

Expected: all selected tests pass and Ruff exits `0`.

- [ ] **Step 5: Commit the light engine**

```bash
git add custom_components/sunrise_alarm/light_engine.py tests/test_light_engine.py
git commit -m "feat: add capability-aware light engine"
```

---

### Task 6: Implement the controller, callback IDs, and preview isolation

**Files:**

- Create: `custom_components/sunrise_alarm/ha_runtime.py`
- Create: `custom_components/sunrise_alarm/controller.py`
- Create: `tests/test_controller.py`

**Interfaces:**

- `RuntimePort.now() -> datetime`
- `RuntimePort.call_at(when, callback) -> Callable[[], None]`
- `RuntimePort.create_task(coroutine, name) -> asyncio.Task[None]`
- `RuntimePort.sleep(seconds) -> Awaitable[None]`
- Controller methods: `async_initialize()`, `async_apply_config(config)`,
  `async_set_enabled(enabled)`, `async_stop(reason="user")`,
  `async_skip_next()`, `async_clear_skip()`, `async_preview(duration=60)`, and
  `async_shutdown()`.
- Controller event interface:
  `async_add_listener(callback) -> Callable[[], None]`.
- Read-only controller properties: `state`, `next_occurrence`, `is_active`,
  `last_outcome`, and `warnings`.

- [ ] **Step 1: Write failing controller state tests with fakes**

Use a fake runtime with explicit time advancement, a fake store, and a fake
light engine. Test these sequences:

```text
initialize enabled -> scheduled
sunrise callback -> sunrise -> final output -> scheduled
stop during sunrise -> scheduled with no later outputs
skip -> exact next occurrence excluded -> skip clears at skipped wake
stale callback -> no state or output change
preview -> snapshot -> preview outputs -> restore -> scheduled
real sunrise during preview -> restore preview -> current sunrise output
shutdown -> all callbacks cancelled and tasks completed
```

Assert ramp calls use progress derived from fake `now`, including a delayed step
that jumps directly to the correct progress.

- [ ] **Step 2: Verify controller tests fail**

```bash
python -m pytest tests/test_controller.py -q
```

Expected: imports fail because controller and runtime modules do not exist.

- [ ] **Step 3: Implement the controller state machine**

Use one `_generation` UUID for each scheduled plan and one `_execution_id` for
active work. Each callback closes over its expected generation and begins with:

```python
if expected_generation != self._generation or self._shutdown:
    return
```

The ramp loop computes:

```python
progress = (self._runtime.now() - occurrence.sunrise_start) / (
    occurrence.wake_time - occurrence.sunrise_start
)
```

It applies the final output exactly once, records `completed` or `degraded`,
clears active recovery state, and recalculates. Catch cancellation separately
from operational errors. Persist only phase transitions, skip changes, and
completion outcomes. Notify a snapshot of registered listeners after every
state, occurrence, outcome, or warning change. Listener exceptions are logged
and isolated from the controller.

Preview snapshots lights, uses a separate task, and restores in `finally`.
Normal sunrise preemption awaits preview cancellation and restoration before
applying current normal-ramp output.

- [ ] **Step 4: Implement the HA runtime adapter**

Use `dt_util.utcnow`, `async_track_point_in_time`, `hass.async_create_task`, and
`asyncio.sleep`. Return every unsubscribe function to the controller and use
clear task names containing the config-entry ID.

- [ ] **Step 5: Run controller and domain tests**

```bash
python -m pytest tests/test_schedule.py tests/test_ramp.py tests/test_controller.py -q
python -m ruff check custom_components/sunrise_alarm/controller.py custom_components/sunrise_alarm/ha_runtime.py tests/test_controller.py
python -m mypy custom_components/sunrise_alarm
```

Expected: all selected tests pass and quality commands exit `0`.

- [ ] **Step 6: Commit orchestration**

```bash
git add custom_components/sunrise_alarm/controller.py custom_components/sunrise_alarm/ha_runtime.py tests/test_controller.py
git commit -m "feat: orchestrate sunrise alarm occurrences"
```

---

### Task 7: Add config-entry lifecycle and integration actions

**Files:**

- Modify: `custom_components/sunrise_alarm/__init__.py`
- Modify: `custom_components/sunrise_alarm/const.py`
- Create: `custom_components/sunrise_alarm/services.yaml`
- Create: `custom_components/sunrise_alarm/strings.json`
- Create: `custom_components/sunrise_alarm/translations/en.json`
- Create: `tests/test_init.py`

**Interfaces:**

- Produces `SunriseAlarmConfigEntry = ConfigEntry[SunriseAlarmController]`.
- Registered actions are `stop`, `skip_next`, `clear_skip`, and `preview`.
- Entity-platform forwarding is added with the concrete platforms in Task 9.
- Actions accept Home Assistant device targets only.

- [ ] **Step 1: Write failing setup, unload, and action tests**

Patch controller initialization, create two config entries, and assert each gets
distinct `runtime_data`. Exercise a device-targeted `preview` call and assert
only the resolved controller receives `async_preview(duration=60)`. Unload and
assert controller shutdown and platform unload both occur.

- [ ] **Step 2: Verify lifecycle tests fail**

```bash
python -m pytest tests/test_init.py -q
```

Expected: setup-entry and action assertions fail against the skeleton.

- [ ] **Step 3: Implement setup and unload**

`async_setup_entry` must parse `AlarmConfig`, create `AlarmStore`,
`HomeAssistantRuntime`, `LightEngine`, and `SunriseAlarmController`, assign
`entry.runtime_data`, initialize the controller, register an in-place update
listener with `entry.async_on_unload`.

`async_unload_entry` must call controller shutdown and clear runtime data after
shutdown completes. An update listener parses the complete entry options and
calls `controller.async_apply_config()`; it does not reload the entry. Task 9
extends unload with concrete entity-platform teardown.

- [ ] **Step 4: Register target-aware actions once**

Register actions in `async_setup`. Resolve each target device through the device
registry identifier `(DOMAIN, alarm_id)` and reject devices not owned by this
integration with `ServiceValidationError`. Validate preview duration as `1..600`
seconds and default it to `60`.

Define matching `services.yaml` selectors and English translation keys for all
four actions in `strings.json` and `translations/en.json`. Never log target
payloads at warning or error level.

- [ ] **Step 5: Run lifecycle tests**

```bash
python -m pytest tests/test_init.py tests/test_controller.py -q
python -m ruff check custom_components/sunrise_alarm/__init__.py tests/test_init.py
```

Expected: all selected tests pass and Ruff exits `0`.

- [ ] **Step 6: Commit lifecycle and actions**

```bash
git add custom_components/sunrise_alarm/__init__.py custom_components/sunrise_alarm/const.py custom_components/sunrise_alarm/services.yaml custom_components/sunrise_alarm/strings.json custom_components/sunrise_alarm/translations/en.json tests/test_init.py
git commit -m "feat: add config lifecycle and alarm actions"
```

---

### Task 8: Implement the initial and options flows with translations

**Files:**

- Create: `custom_components/sunrise_alarm/config_flow.py`
- Modify: `custom_components/sunrise_alarm/strings.json`
- Modify: `custom_components/sunrise_alarm/translations/en.json`
- Create: `tests/test_config_flow.py`

**Interfaces:**

- Initial steps: `user`, `schedule`, `lights`, `behavior`, `review`.
- Options steps: `init`, `schedule`, `lights`, `behavior`, `review`.
- Flow output uses model keys from `const.py` without duplicate helper state.

- [ ] **Step 1: Write failing initial-flow tests**

Drive every step with `hass.config_entries.flow.async_init()` and
`async_configure()`. Verify defaults use `hass.config.time_zone`, review
placeholders show calculated wake and sunrise timestamps, and create-entry data
contains alarm ID, name, optional area, provider, and timezone while options
contain schedule, light, behavior, and enabled fields.

Add exact error tests for no weekdays, no lights, invalid brightness ordering,
Kelvin outside `1000..10000`, interval outside `5..60`, and invalid timezone.

- [ ] **Step 2: Write failing options-flow tests**

Start from a loaded entry, change wake time and lights, complete review, and
assert the full options mapping is replaced without losing unchanged values.
Cancel at review and assert the entry remains unchanged.

- [ ] **Step 3: Verify flow tests fail**

```bash
python -m pytest tests/test_config_flow.py -q
```

Expected: import fails because `config_flow.py` does not exist.

- [ ] **Step 4: Implement flow state collection and shared validation**

Use Home Assistant selectors for timezone, time, multi-select weekdays, multiple
light entities, number ranges, curve selection, and booleans. Generate
`alarm_id` with `uuid4().hex`. Build an `AlarmConfig` before entering review so
one validation path serves initial flow, options flow, startup, and entities.

The review step displays formatted next wake and sunrise values and offers
`finish` or `preview`. Selecting preview calls a flow-local helper that
snapshots the selected lights, applies progress `0.0`, `0.5`, and `1.0` over ten
seconds through `LightEngine`, restores the snapshot in `finally`, and returns
to review without creating an entry. Patch that helper in config-flow tests so
they do not sleep. Selecting finish creates the entry. Duplicate display names
are allowed.

- [ ] **Step 5: Add complete English translation data**

Define titles, descriptions, field labels, action labels, entity names, and
errors for `invalid_timezone`, `no_weekdays`, `no_lights`, `invalid_brightness`,
`invalid_kelvin`, and `invalid_interval`. Keep `strings.json` and
`translations/en.json` structurally identical.

- [ ] **Step 6: Run flow and translation tests**

```bash
python -m pytest tests/test_config_flow.py -q
python -m ruff check custom_components/sunrise_alarm/config_flow.py tests/test_config_flow.py
python -m json.tool custom_components/sunrise_alarm/strings.json > /dev/null
python -m json.tool custom_components/sunrise_alarm/translations/en.json > /dev/null
```

Expected: all commands exit `0`.

- [ ] **Step 7: Commit setup flows**

```bash
git add custom_components/sunrise_alarm/config_flow.py custom_components/sunrise_alarm/strings.json custom_components/sunrise_alarm/translations/en.json tests/test_config_flow.py
git commit -m "feat: add sunrise alarm setup flows"
```

---

### Task 9: Expose the alarm device and native entities

**Files:**

- Create: `custom_components/sunrise_alarm/entity.py`
- Create: `custom_components/sunrise_alarm/switch.py`
- Create: `custom_components/sunrise_alarm/sensor.py`
- Create: `custom_components/sunrise_alarm/binary_sensor.py`
- Create: `custom_components/sunrise_alarm/time.py`
- Create: `custom_components/sunrise_alarm/number.py`
- Create: `custom_components/sunrise_alarm/button.py`
- Modify: `custom_components/sunrise_alarm/__init__.py`
- Modify: `tests/test_init.py`
- Create: `tests/test_entities.py`

**Interfaces:**

- Base unique ID format is `<alarm_id>_<entity_key>`.
- Device identifier is `(DOMAIN, alarm_id)`.
- Entity updates subscribe to one controller listener and remove it through
  `async_on_remove`.
- Concrete platforms are `binary_sensor`, `button`, `number`, `sensor`,
  `switch`, and `time`.

- [ ] **Step 1: Write failing device and state tests**

After setup, assert one device and these entities exist: enable switch,
next-alarm sensor, status sensor, active binary sensor, wake time, sunrise
duration, stop, skip, and preview buttons. Assert timestamp sensor state class
is `timestamp`, active is true only for sunrise or preview, and status reflects
the controller state.

- [ ] **Step 2: Write failing command and availability tests**

Verify switch, time, and number updates replace corresponding config-entry
options. Verify stop is unavailable while scheduled, skip is available only with
a next occurrence, and preview is unavailable while active. Press each button
and assert the matching controller method is awaited once.

- [ ] **Step 3: Verify entity tests fail**

```bash
python -m pytest tests/test_entities.py -q
```

Expected: platform modules do not exist or no entities are created.

- [ ] **Step 4: Implement the common entity base and read-only entities**

First update `async_setup_entry` to forward the six concrete platforms after
controller initialization, and update `async_unload_entry` to shut down the
controller before unloading those platforms.

The base returns `DeviceInfo` with the integration identifier, config-entry
name, optional configured area suggestion, manufacturer `Sunrise Alarm`, and
model `Weekly Sunrise Alarm`. It exposes controller availability and calls
`async_write_ha_state()` from the controller listener on the event loop.

Implement sensors with native datetime values, enum-like status values, and
entity descriptions. The binary sensor is on for `SUNRISE` and `PREVIEWING`.

- [ ] **Step 5: Implement writable configuration entities and buttons**

The switch calls `controller.async_set_enabled()` and then updates entry
options. The time and duration entities validate through `AlarmConfig` before
calling `hass.config_entries.async_update_entry()`. Duration range is `1..180`
minutes with step `1`.

Buttons delegate only to controller methods. Stop does not directly call any
light service; skip does not mutate sensor state directly.

- [ ] **Step 6: Run entity and lifecycle tests**

```bash
python -m pytest tests/test_entities.py tests/test_init.py -q
python -m ruff check custom_components/sunrise_alarm tests/test_entities.py
python -m mypy custom_components/sunrise_alarm
```

Expected: all selected tests pass and quality commands exit `0`.

- [ ] **Step 7: Commit entities**

```bash
git add custom_components/sunrise_alarm/__init__.py custom_components/sunrise_alarm/entity.py custom_components/sunrise_alarm/switch.py custom_components/sunrise_alarm/sensor.py custom_components/sunrise_alarm/binary_sensor.py custom_components/sunrise_alarm/time.py custom_components/sunrise_alarm/number.py custom_components/sunrise_alarm/button.py tests/test_init.py tests/test_entities.py
git commit -m "feat: expose sunrise alarm entities"
```

---

### Task 10: Complete restart recovery and manual-off behavior

**Files:**

- Modify: `custom_components/sunrise_alarm/controller.py`
- Modify: `custom_components/sunrise_alarm/light_engine.py`
- Modify: `custom_components/sunrise_alarm/__init__.py`
- Create: `tests/test_recovery.py`
- Modify: `tests/test_controller.py`
- Modify: `tests/test_light_engine.py`

**Interfaces:**

- Recovery grace is exactly ten minutes.
- Manual-off listeners compare state context IDs against the light engine's
  bounded integration-context set.

- [ ] **Step 1: Write failing restart recovery tests**

Freeze time and preload records for four cases:

```text
before sunrise -> state scheduled, no light call
during sunrise -> first output uses current absolute progress
after wake by 5 minutes -> final output once, outcome recovered
after wake by 11 minutes -> no light call, outcome missed
```

Also preload an expired skip and assert it clears before recurrence calculation.
Preload a preview phase and assert it is ignored.

- [ ] **Step 2: Write failing manual-off tests**

With the option enabled, fire external state changes until all controlled lights
are off and assert `async_stop("manual_off")`. Repeat with a context ID created
by the light engine and assert no stop. With the option disabled, external off
changes must not stop the occurrence.

- [ ] **Step 3: Verify recovery tests fail**

```bash
python -m pytest tests/test_recovery.py tests/test_controller.py tests/test_light_engine.py -q
```

Expected: at least the recovery and manual-off assertions fail.

- [ ] **Step 4: Implement initialization recovery policy**

Load the store before normal recalculation. Match records by occurrence ID and
apply exactly one branch from the four-case policy. Clear invalid, expired, and
preview records. After recovered or missed handling, calculate the following
occurrence before notifying entities.

- [ ] **Step 5: Add and clean up manual-off listeners**

Register `async_track_state_change_event` only while a normal sunrise is active
and the option is enabled. Ignore unavailable transitions and the engine's own
context IDs. Re-read every controlled state before deciding all are off. Store
the unsubscribe callback with the active execution and always remove it on stop,
completion, disable, error, option change, and unload.

- [ ] **Step 6: Run all runtime tests**

```bash
python -m pytest tests/test_controller.py tests/test_light_engine.py tests/test_recovery.py tests/test_init.py -q
python -m ruff check custom_components/sunrise_alarm tests
python -m mypy custom_components/sunrise_alarm
```

Expected: all selected tests pass and quality commands exit `0`.

- [ ] **Step 7: Commit recovery behavior**

```bash
git add custom_components/sunrise_alarm tests/test_recovery.py tests/test_controller.py tests/test_light_engine.py
git commit -m "feat: recover interrupted sunrise occurrences"
```

---

### Task 11: Add HACS metadata, documentation, and acceptance verification

**Files:**

- Create: `hacs.json`
- Create: `README.md`
- Modify: `custom_components/sunrise_alarm/manifest.json`
- Modify: `tests/test_init.py`

**Interfaces:**

- Documentation describes only implemented Milestones 1–2 behavior.
- Reliability warning explicitly recommends retaining an independent alarm.

- [ ] **Step 1: Add failing metadata assertions**

Extend `tests/test_init.py` to parse `manifest.json` and `hacs.json`, asserting
domain, version, config flow, minimum HA version, and rendered README sections
for installation, setup, DST, restart recovery, light limitations, and
reliability.

- [ ] **Step 2: Verify metadata assertions fail**

```bash
python -m pytest tests/test_init.py -q
```

Expected: failure because `hacs.json` and `README.md` do not exist.

- [ ] **Step 3: Add HACS metadata and focused documentation**

Use:

```json
{
  "name": "Sunrise Alarm",
  "homeassistant": "2026.7.4",
  "render_readme": true
}
```

Document HACS installation, UI setup, entity/action inventory, DST rules,
restart policy, heterogeneous-light degradation, manual-off limitations, and
that this is not a safety-critical alarm. State clearly that Apple Sleep
Schedule synchronization, audio, and snooze are not included.

- [ ] **Step 4: Run the complete verification suite**

```bash
python -m pytest -q
python -m ruff check custom_components tests
python -m mypy custom_components/sunrise_alarm
python -m json.tool custom_components/sunrise_alarm/manifest.json > /dev/null
python -m json.tool custom_components/sunrise_alarm/strings.json > /dev/null
python -m json.tool custom_components/sunrise_alarm/translations/en.json > /dev/null
python -m json.tool hacs.json > /dev/null
git diff --check
```

Expected: every command exits `0`; pytest reports no failures or errors.

- [ ] **Step 5: Verify unload and callback acceptance explicitly**

Run focused acceptance tests with verbose names:

```bash
python -m pytest tests/test_recovery.py tests/test_init.py tests/test_entities.py -vv
```

Expected: restart, unload, callback cancellation, and entity-control tests all
pass with no pending-task warnings.

- [ ] **Step 6: Commit distribution-ready Milestones 1–2**

```bash
git add hacs.json README.md custom_components/sunrise_alarm/manifest.json tests/test_init.py
git commit -m "docs: prepare Sunrise Alarm for HACS testing"
```

---

## Final Review Checklist

- [ ] Every config-entry callback is cancelled on unload.
- [ ] Every callback checks its captured generation or execution ID.
- [ ] Every ramp output derives from absolute aware timestamps.
- [ ] Skip survives restart only until the skipped wake instant.
- [ ] Preview restores light state and cannot replace a normal occurrence.
- [ ] Real sunrise preempts preview in restore-then-apply order.
- [ ] DST gap and repetition tests use Europe/Berlin 2026 transitions.
- [ ] Light calls include only currently supported attributes.
- [ ] One light failure does not block another call.
- [ ] All-light failure records degraded rather than controller error.
- [ ] Restart after grace never changes lights.
- [ ] Options are one authoritative editable configuration mapping.
- [ ] No deferred entity, action, file, or user-facing promise exists.
- [ ] English strings cover every flow, entity, action, and validation error.
- [ ] Full pytest, Ruff, mypy, JSON, and whitespace verification passes.
