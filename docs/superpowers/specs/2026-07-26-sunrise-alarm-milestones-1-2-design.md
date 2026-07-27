# Sunrise Alarm Milestones 1–2 Design

**Status:** Approved design  
**Date:** 2026-07-26  
**Integration domain:** `sunrise_alarm`  
**Target baseline:** Home Assistant Core 2026.7.4
**Distribution target:** HACS custom integration

## 1. Purpose

This design defines the first implementation slice of Sunrise Alarm: Milestones
1–2. It covers a fixed Home Assistant weekly schedule, a controller-owned state
machine, capability-aware light ramps, preview, skip, stop, and restart
recovery.

Home Assistant is the sole schedule source in this slice. Audio, snooze,
external timestamps, and Apple integrations are deferred.

## 2. Scope

### Included

- Fixed weekly wake schedule in a configurable timezone
- Active weekday selection
- Daylight-saving transition policy
- Multiple controlled lights
- Brightness ramps
- Configurable initial and final Kelvin values
- Kelvin-to-RGB fallback for RGB/XY lights
- Linear and natural ramp curves
- Enable and disable
- Stop
- Skip next and clear skip
- Shortened preview with light-state restoration
- Next-alarm and status entities
- Mid-sunrise restart recovery
- Initial config flow and options flow
- Automated domain, controller, integration, and recovery tests

### Deferred

- Audio and volume ramps
- Snooze
- One-off wake override
- Timestamp, Android, calendar, and Apple providers
- Arbitrary stages and Home Assistant action stages
- Repairs and full diagnostics
- German translation
- Release automation and distribution workflows

The integration will not expose placeholder entities or actions for deferred
features.

## 3. Architectural approach

The implementation uses a pure domain core with thin Home Assistant adapters.

### 3.1 Domain layer

The domain layer contains:

- Immutable configuration and occurrence models
- Weekly schedule and DST calculations
- Ramp curves and output calculations
- State-transition rules

It has no dependency on Home Assistant APIs. Date and time inputs are explicit,
making scheduling and recovery deterministic under test.

### 3.2 Controller layer

One `SunriseAlarmController` is the sole authority for one configured alarm. It
owns:

- Current operational state
- Next calculated occurrence
- Active occurrence
- Skip target
- Preview execution
- Registered callback cancellation functions
- Active tasks
- Recent warnings and transition outcomes

Entities and integration actions never modify runtime state directly. They
delegate commands to the controller.

### 3.3 Home Assistant adapter layer

Adapters provide:

- Config-entry setup and unload
- Config and options flows
- Device and entity platforms
- Integration actions
- Timer and state-listener registration
- Light capability discovery
- Light service calls
- Minimal runtime persistence

Each typed `ConfigEntry` stores its controller in `runtime_data`.

### 3.4 Provider boundary

The fixed weekly scheduler implements the alarm-provider boundary used by the
controller. It is the only provider in this slice. The boundary remains narrow
enough to add external providers without changing the sunrise engine.

## 4. Components

### Core modules

- `models.py`: typed configuration, occurrence models, enums, validation
- `schedule.py`: pure occurrence and DST calculations
- `ramp.py`: pure progress, curve, interpolation, and conversion functions
- `controller.py`: state machine and occurrence orchestration
- `light_engine.py`: capability-aware output planning and dispatch
- `storage.py`: versioned minimal recovery state

### Home Assistant modules

- `__init__.py`: integration lifecycle and action registration
- `config_flow.py`: initial setup and options flow
- `entity.py`: shared alarm entity base
- `switch.py`, `sensor.py`, `binary_sensor.py`, `time.py`, `number.py`,
  `button.py`: entity platforms
- `const.py`: domain constants and defaults
- `manifest.json`, `services.yaml`, `strings.json`, `translations/en.json`:
  metadata and localization

Files for media, diagnostics, or repairs will be added when those capabilities
are implemented. Empty placeholders are prohibited.

## 5. Data ownership

### 5.1 Config-entry data

Effectively immutable identity data:

- Stable generated alarm identifier
- Alarm name
- Optional area selection
- Provider type (`fixed_schedule`)
- Alarm timezone

Display names do not have to be unique. Entity unique IDs derive from the stable
alarm identifier and entity key.

### 5.2 Config-entry options

User-editable behavior:

- Wake time
- Active weekdays
- Selected lights
- Sunrise duration
- Initial and final brightness
- Initial and final Kelvin
- Ramp curve
- Requested update interval
- Manual-all-off behavior
- Enabled state

The config flow, options flow, `time` entity, `number` entity, and enable switch
all read or update this same configuration. No helper entity maintains an
independent copy.

### 5.3 Persisted runtime record

A versioned Home Assistant `Store` record contains only data required for safe
recovery:

- Intended occurrence identifier and timestamps
- Active phase when recovery remains meaningful
- Skip target occurrence
- Last successful occurrence
- Last missed occurrence

Ramp progress is not persisted. It is recalculated from absolute aware
timestamps.

## 6. Scheduling and DST

### 6.1 Occurrence calculation

The fixed provider receives an aware `now` and calculates the next occurrence
from local wake time, active weekdays, alarm timezone, enabled state, and skip
target.

Wake and sunrise timestamps are retained as aware values and normalized to UTC
for identity and comparison. Entity presentation uses the alarm timezone.

```text
sunrise_start = wake_time - sunrise_duration
```

An empty weekday set is invalid configuration.

### 6.2 DST validation

A candidate local wall time is validated by round-tripping through UTC.

- Normal time: use the sole valid instant.
- Repeated time: use `fold=0`, the first occurrence.
- Nonexistent time: advance through local wall-clock time until the first valid
  instant after the requested time.

Each local schedule occurrence therefore maps to exactly one UTC instant.

### 6.3 Callback and skip safety

Every occurrence has a unique execution identifier. Scheduled callbacks capture
the expected identifier and perform no work unless it still matches the
controller's current occurrence. Recalculation cancels obsolete callbacks before
registering replacements.

Skipping records the exact currently calculated occurrence as the skip target,
schedules the following eligible occurrence, and registers a callback at the
skipped wake time to clear the target. After a restart before that instant, the
same occurrence remains excluded. After that instant, an expired skip target is
cleared during initialization even if its callback never ran.

## 7. State and execution model

### 7.1 Operational states

The durable states for this slice are:

```text
disabled
scheduled
sunrise
previewing
error
```

`skipped`, `dismissed`, `missed`, `completed`, and `degraded` are recorded
outcomes or transition metadata rather than long-lived states.
`waiting_for_source`, `ringing`, and `snoozed` are deferred until their
corresponding providers and audio behavior exist.

### 7.2 Normal occurrence

1. Calculate the next occurrence.
2. Register an absolute callback for sunrise start.
3. At sunrise start, create or validate the execution ID and enter `sunrise`.
4. Start one cancellable ramp task.
5. At each step, calculate progress from current time and absolute occurrence
   timestamps.
6. Dispatch capability-filtered commands independently to each light.
7. At wake time, send the exact final output once.
8. Record the outcome and schedule the next occurrence.

Delayed task execution does not accumulate drift because progress is never
advanced by a step counter.

### 7.3 Preview

Preview is an isolated execution:

- Preserve the scheduled occurrence and its callbacks.
- Snapshot selected light states.
- Enter `previewing` and run a shortened ramp.
- Restore the snapshot on completion or cancellation.
- Return to the appropriate schedule state.
- Never persist or recover a preview across restart.

A preview cannot skip, replace, or recalculate the normal occurrence. If a real
sunrise becomes due during preview, the real occurrence preempts it: preview is
cancelled, its snapshot is restored, and the current absolute sunrise output is
then applied.

### 7.4 Stop and disable

Stopping an active sunrise or preview cancels future commands and leaves
normal-occurrence lights at their current state. Preview cancellation restores
its snapshot.

Disabling performs the relevant stop behavior, cancels future callbacks, and
enters `disabled`. Re-enabling recalculates from the current time.

## 8. Restart recovery

On controller initialization:

- Before sunrise start: schedule normally.
- Between sunrise start and wake: calculate current progress immediately and
  resume.
- Between wake and the ten-minute grace deadline: apply the final light output
  once and record the occurrence as recovered.
- After the grace deadline: record the occurrence as missed without changing
  lights, then schedule the next occurrence.
- Preview records are ignored.

There is no ringing recovery in this slice because audio is deferred.

## 9. Light engine

### 9.1 Capability priority

The engine reads current capabilities before every occurrence:

1. Colour-temperature light: brightness plus `color_temp_kelvin`
2. RGB/XY light: brightness plus an RGB conversion of the Kelvin target
3. Brightness-only light: brightness only
4. On/off-only light: turn on at sunrise start and report a compatibility
   warning

Unsupported attributes are never sent. Brightness and Kelvin are clamped
separately for every light.

### 9.2 Configuration constraints

- Initial brightness range: 1–100 percent
- Final brightness range: initial brightness through 100 percent
- Initial and final Kelvin values are configurable within 1,000–10,000 K
- Either warm-to-cool or cool-to-warm direction is valid
- Requested update interval range: 5–60 seconds
- Default duration: 30 minutes
- Default update interval: 10 seconds
- Default curve: natural

### 9.3 Progress and curves

```python
progress = max(0.0, min(elapsed_seconds / duration_seconds, 1.0))
output = start + curve(progress) * (end - start)
```

Required curves in this slice:

```python
def linear(progress: float) -> float:
    return progress


def natural(progress: float) -> float:
    return progress**2.2
```

The effective interval may exceed the requested interval to cap one occurrence
at 360 ramp updates. The final target is always dispatched exactly at
completion.

### 9.4 Failure isolation

- A failing light records a redacted warning; other lights continue.
- A recovered light rejoins at current calculated progress.
- If every light fails, the occurrence advances and records a degraded outcome.
- Controller `error` is reserved for scheduling, persistence, or orchestration
  failures.
- Persistent repair issues are deferred.

### 9.5 Manual-off detection

Integration-issued light calls carry Home Assistant context identifiers.
Matching state changes are ignored as integration activity.

When the optional behavior is enabled, an external transition that leaves all
controlled lights off stops the active sunrise. This is best-effort because not
every integration preserves service-call context. The option defaults to
disabled.

## 10. Config and options flows

### 10.1 Initial flow

1. Identity: name, optional area, timezone
2. Schedule: wake time, weekdays, initially enabled
3. Lights: entities, duration, brightness endpoints, Kelvin endpoints, curve,
   interval
4. Behavior: manual-all-off option
5. Review: next wake, sunrise start, capability warnings, optional preview

The flow rejects missing weekdays, missing lights, unknown timezones, invalid
ranges, and inconsistent endpoints. All errors use translation keys.

### 10.2 Options flow

The editable sections can be changed later. Applying a valid complete options
replacement:

1. Updates controller configuration in place.
2. Cancels obsolete future callbacks.
3. Keeps an active occurrence's timing and ramp parameters unchanged.
4. Immediately stops commanding lights removed from the selection; remaining
   active lights continue with the occurrence snapshot.
5. Applies all other changed settings to the next occurrence.
6. Recalculates the next future occurrence.
7. Refreshes entity state.

Ordinary option changes do not require a config-entry reload.

## 11. Device, entities, and actions

One configured alarm creates one Home Assistant device.

### Entities

- Enable switch
- Next-alarm timestamp sensor
- Status sensor
- Active binary sensor
- Wake-time entity
- Sunrise-duration number
- Stop button
- Skip-next button
- Preview button

Brightness, Kelvin, weekdays, and curve remain in the options flow initially to
avoid an excessive entity count.

Availability rules:

- Stop is available during sunrise or preview.
- Skip next is available when an occurrence is scheduled.
- Preview is available while configured lights exist and no occurrence is
  active.
- The wake-time entity applies to the fixed provider.

### Integration actions

Only implemented actions are registered:

```text
sunrise_alarm.stop
sunrise_alarm.skip_next
sunrise_alarm.clear_skip
sunrise_alarm.preview
```

Actions use Home Assistant device targets and resolve each selected alarm device
to its controller. Entity buttons invoke the same controller methods. `start`,
`snooze`, and `set_next_wake` are deferred.

## 12. Lifecycle

- Every timer and listener has an explicit cancellation callback.
- Config-entry unload blocks new work before cancelling callbacks and tasks.
- The provider is stopped before runtime data is released.
- Ramp and preview tasks handle cancellation without sending another light
  command.
- Required recovery state is flushed before unload completes.
- Stored configuration and recovery records are schema-versioned.
- Setup validates stored configuration before scheduling work.
- Unloading an entry leaves no callbacks, listeners, or active tasks.

## 13. Testing strategy

### 13.1 Pure domain tests

- Alarm later today and already passed
- Weekday and Friday-to-Monday rollover
- Empty weekday rejection
- Skip-target exclusion
- Europe/Berlin spring-forward gap
- Europe/Berlin repeated autumn time
- Timezone changes
- Ramp endpoints and midpoint
- Linear and natural curves
- Brightness and Kelvin clamping
- Kelvin-to-RGB conversion
- Occurrence identity and transition rules

### 13.2 Controller tests with fakes

- Normal sunrise
- Delayed updates without drift
- Stop, disable, skip, and clear skip
- Preview isolation and restoration
- Partial and complete light failure
- Stale callback rejection
- Option updates while scheduled and active
- Shutdown with active work

### 13.3 Home Assistant integration tests

- Successful config and options flows
- Validation and translation-key errors
- Device and entity creation
- Entity commands and integration actions
- Config-entry setup and unload
- Capability discovery
- Service payload filtering
- Runtime-store restoration

### 13.4 Recovery tests

- Restart before sunrise
- Restart midway through sunrise
- Restart after wake inside grace
- Restart after grace
- Invalid or obsolete persisted occurrence
- Preview interrupted by restart

Tests use controlled clocks and captured service calls rather than real sleeps.

## 14. Repository shape

The implementation phase will create:

```text
custom_components/sunrise_alarm/
tests/
docs/superpowers/specs/
pyproject.toml
README.md
hacs.json
```

Packaging and release automation remain outside this slice, but the structure
will remain compatible with HACS.

## 15. Acceptance criteria

Milestones 1–2 are accepted when:

1. A fixed weekly schedule and its sunrise start are calculated correctly.
2. DST gap and repetition policies pass deterministic tests.
3. Two heterogeneous lights follow one ramp without unsupported service
   attributes.
4. Restart during sunrise resumes near the correct absolute progress.
5. One failed light does not prevent another light from running.
6. Stop, skip, clear skip, preview, enable, and disable behave consistently.
7. Preview preserves the scheduled occurrence and restores prior light state.
8. Stale callbacks cannot mutate a replaced occurrence.
9. Unloading leaves no callbacks, listeners, or tasks.
10. All user-facing strings use translation keys.

## 16. Corrections to the draft product specification

This design makes the following scope clarifications:

- Snooze is deferred with audio; it is not exposed in Milestones 1–2.
- `ringing`, `snoozed`, and `waiting_for_source` are not active states before
  their features exist.
- `skipped`, `missed`, and completion are outcomes rather than durable idle
  states.
- Actions for deferred capabilities are not registered as placeholders.
- A preview has an explicit transient `previewing` state but never changes the
  scheduled occurrence.
- Restart inside the post-wake grace period applies final light output because
  no audible phase exists yet.
