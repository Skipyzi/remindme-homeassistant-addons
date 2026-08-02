# Sunrise Alarm for Home Assistant

Sunrise Alarm is a local Home Assistant custom integration that gradually
controls bedroom lights before a fixed weekly wake time. Home Assistant is the
single source of truth for the schedule.

The current release contains the scheduling and light-ramp features from
Milestones 1–2. It does not include audio, snooze, external timestamp sources,
or Apple Sleep Schedule synchronization.

## Installation

1. Add this repository to HACS as a custom integration repository.
2. Install **Sunrise Alarm** in HACS.
3. Restart Home Assistant.
4. Open **Settings → Devices & services → Add integration → Sunrise Alarm**.

The minimum supported Home Assistant Core version is **2026.7.4**.

## Setup

The setup wizard collects:

- Alarm name, optional area, and timezone
- Local wake time and active weekdays
- One or more lights
- Sunrise duration, brightness endpoints, and Kelvin endpoints
- Linear or natural ramp curve
- Optional stop behavior when all controlled lights are switched off manually

Each alarm creates one Home Assistant device with enable, schedule, status,
stop, skip-next, and preview controls. Standard setup does not require YAML.

## Daylight-saving time

Fixed schedules use the configured alarm timezone.

- A nonexistent spring-forward wake time runs at the first valid local time
  after the requested time.
- A repeated autumn wake time runs once, using the first occurrence.

Occurrence identity and callback comparisons use unambiguous aware timestamps.

## Restart recovery

After Home Assistant restarts:

- Before sunrise start, the occurrence is scheduled normally.
- During sunrise, output resumes at progress calculated from the current time.
- Up to ten minutes after wake time, final light output is applied once.
- After that grace period, the occurrence is marked missed and lights are not
  changed.

Preview executions are never recovered after restart.

## Light compatibility

The integration checks every light's current capabilities before each service
call:

1. Colour-temperature lights receive brightness and clamped Kelvin values.
2. RGB and XY lights receive brightness and a Kelvin-derived RGB value.
3. Brightness-only lights receive brightness only.
4. On/off-only lights turn on at sunrise start.

One unavailable or failing light does not prevent other selected lights from
continuing. Different bulb models can still render colours differently.

## Controls and actions

Entities include enabled, next alarm, status, active, wake time, sunrise
duration, stop, skip next, and preview.

Implemented actions are:

- `sunrise_alarm.stop`
- `sunrise_alarm.skip_next`
- `sunrise_alarm.clear_skip`
- `sunrise_alarm.preview`

Preview restores the selected lights to their prior states and does not change
the next scheduled occurrence.

## Apple Sleep Schedule

Apple does not expose the next Sleep Schedule wake time directly to Home
Assistant. This release does not claim or implement Apple synchronization. A
future experimental Shortcut bridge may accept a wake timestamp if iOS makes
one available to a Shortcut.

## Reliability

Sunrise Alarm depends on Home Assistant, power, networking, and the selected
light integrations. It is **not a safety-critical alarm**. Retain an independent
audible alarm when waking at a specific time is important.
