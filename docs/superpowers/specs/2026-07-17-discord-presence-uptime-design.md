# Discord Presence Lifetime Uptime Design

## Goal

Add cumulative bot uptime and lifetime availability to the Discord bot's rich presence while preserving the existing Pi-agent connectivity signal.

Example presence:

```text
Pi connected • Up 12d 4h • 99.99% • !help
```

When the Pi bridge is unavailable, only the connectivity label changes:

```text
Pi offline • Up 12d 4h • 99.99% • !help
```

## Definitions

- **Total uptime:** accumulated time the Discord bot process has been running across all tracked sessions.
- **Tracking lifetime:** wall-clock time from the first successful initialization of this feature until now.
- **Availability:** `totalOnlineMs / trackingLifetimeMs × 100`, clamped to 0–100 and displayed with two decimal places.
- **Downtime:** every wall-clock gap while the bot is not running, including updates, intentional restarts, crashes, and host outages.

Tracking begins when this release first starts. Historical availability before that point is unknowable and is not synthesized.

## Persistent State

Create `discord-pi-bot/src/presenceUptime.ts` with a focused `PresenceUptimeTracker`. Persist versioned JSON at `/data/presence-uptime.json`, configurable for tests through `PRESENCE_UPTIME_PATH`.

```ts
interface PresenceUptimeState {
  version: 1;
  trackingStartedAt: number;
  totalOnlineMs: number;
  lastHeartbeatAt: number;
  sessionId: string;
}
```

The tracker owns an in-memory `lastSampleAt` for the current process. On initialization:

1. Read and validate the existing state, or create a new state at the current time.
2. Generate a cryptographically random session ID.
3. Replace the persisted session ID and heartbeat without adding the offline gap.
4. Keep the original `trackingStartedAt` and accumulated `totalOnlineMs`.

On each sample:

1. Add `max(0, now - lastSampleAt)` to `totalOnlineMs`.
2. Set `lastSampleAt` and `lastHeartbeatAt` to now.
3. Atomically persist the complete state.
4. Return a snapshot containing total uptime and availability.

A crash can undercount up to one heartbeat interval of online time. This is preferable to incorrectly crediting offline time.

## Storage Safety

- Parent directory mode: `0700` where supported.
- File mode: `0600`.
- Write to a unique temporary file, fsync/close where practical, rename atomically, and enforce final permissions.
- State contains timestamps, counters, and a random session identifier only—no Discord, Supervisor, Pi-agent, or model credentials.
- Reject non-finite, negative, future, unsupported-version, or structurally invalid fields.
- Rename corrupt state to a timestamped `.corrupt` file and begin a fresh tracking lifetime.
- A persistence failure must not stop Discord presence updates; retain the in-memory snapshot and log a credential-free error.

## Presence Integration

`startPresenceMonitor` creates one tracker and initializes it before the first presence update. Every existing 60-second monitor tick:

1. Sample and persist uptime.
2. Check Pi-agent reachability.
3. Format the activity state.
4. Call Discord `setPresence`.

The presence formatter is pure and independently tested. Duration uses whole days, hours, and minutes, omitting zero-value leading units:

- `0m`
- `47m`
- `3h 8m`
- `12d 4h`

Availability always uses two decimals, including `100.00%`. The complete state string must remain below Discord's 128-character activity-state limit.

`updatePresence` accepts the current uptime snapshot so it does not perform file I/O itself. If tracker initialization or persistence fails, the monitor uses process uptime for the displayed duration and `100.00%` as a non-persisted fallback for the current session; it retries persistence on later ticks.

## Lifecycle and Concurrency

The bot has one presence monitor per process. A random session ID prevents accidentally crediting a prior session's offline gap. All tracker operations are serialized through the monitor's single timer callback; overlapping ticks are guarded so a slow Pi-agent request cannot double-credit time or issue competing file writes.

All stopped gaps count as downtime. The design does not attempt to identify planned maintenance.

## Testing

### Tracker tests

- First initialization creates valid `0600` state and reports 100% availability.
- Same-session samples add elapsed online time.
- Restart initialization preserves accumulated uptime, excludes the offline gap from uptime, and includes it in availability's denominator.
- Time moving backward adds no online time.
- Corrupt and unsupported state is quarantined and replaced.
- Atomic write failure remains nonfatal and never exposes secrets.

### Formatter tests

- Durations format correctly across minute, hour, and day boundaries.
- Availability is clamped and rendered to two decimals.
- Connected and offline labels preserve `!help` and stay under 128 characters.

### Presence monitor tests

- The first update includes an uptime snapshot.
- Timer ticks do not overlap.
- Pi-agent reachability still controls Discord online/idle status.
- Persistence errors fall back without stopping presence updates.

## Packaging and Release

- Export `PRESENCE_UPTIME_PATH=/data/presence-uptime.json` from `discord-pi-bot/run.sh`.
- Document that availability starts when version `2.3.2` is installed and that all stopped gaps count as downtime.
- Release RemindMe as `2.3.2`.
- Keep llama.cpp at `1.9.2`.
