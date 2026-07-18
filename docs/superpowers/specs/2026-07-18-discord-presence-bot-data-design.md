# Discord Presence Bot Data Design

## Goal

Use Discord's bot-supported Gateway activity fields to display RemindMe health, cumulative uptime, lifetime availability, and active reminder count.

Discord's full Rich Presence platform is intended for user game/app activity through the Social SDK or Embedded App SDK. Bot accounts use Gateway presence updates and cannot use the full Rich Presence art, party, Join, or button surface.

## Display

Keep the existing `Watching` activity and split data across its two text fields:

```text
name:  RemindMe • Pi connected
state: Up 12d 4h • 99.99% • 3 reminders
```

When the Pi-agent bridge is unavailable:

```text
name:  RemindMe • Pi offline
state: Up 12d 4h • 99.99% • 3 reminders
```

Discord status remains `online` when the Pi-agent bridge responds and `idle` otherwise. Some Discord clients may render activity state less prominently than activity name; no unsupported RPC workaround will be added.

## Reminder Count

The count represents active, unnotified reminders belonging to the configured `OWNER_ID`, matching RemindMe's canonical Home Assistant synchronization identity. It excludes:

- reminders belonging to other Discord users;
- reminders already marked notified;
- deleted reminders.

Add a focused `getActiveReminderCount(userId: string): number` export to the reminder manager rather than exposing its internal map. If `OWNER_ID` is blank, the default count is zero.

The presence monitor reads the count on every existing 60-second tick, so additions, deliveries, and deletions appear without a second timer or event bus.

## Presence Interfaces

Extend the pure formatter to accept a reminder count:

```ts
formatPresenceActivity(
  connected: boolean,
  snapshot: UptimeSnapshot,
  reminderCount: number,
): { name: string; state: string }
```

Formatting rules:

- Activity name: `RemindMe • Pi connected` or `RemindMe • Pi offline`.
- Activity state: `Up <duration> • <availability>% • <count> reminder(s)`.
- Clamp reminder count to a finite, non-negative integer.
- Use `1 reminder`; all other values use `reminders`.
- Keep both fields below 128 characters.

`updatePresence` receives or resolves the current reminder count and passes the two formatted fields to `setPresence`. The existing serialized heartbeat monitor remains responsible for preventing overlapping ticks.

## Error Handling

- A reminder-count exception is caught and reported with a generic credential-free message.
- Presence continues with `0 reminders` after a count failure.
- Uptime persistence and Pi-agent reachability fallbacks remain unchanged.
- No reminder text, user ID, channel ID, credential, or internal file path enters presence or logs.

## Testing

- Active reminder count includes only unnotified reminders for the requested owner.
- Count changes after set, delete, and notification completion.
- Formatter produces connected/offline names and correct singular/plural states.
- Invalid counts clamp to zero.
- Name and state remain below 128 characters.
- Presence monitor refreshes reminder count each tick.
- Count failures produce `0 reminders` and do not stop future updates.
- Existing uptime, reminder persistence, and Discord status tests continue passing.

## Packaging and Release

- Document the bot-compatible Gateway presence limitation and displayed fields.
- Release RemindMe as `2.3.3`.
- Keep managed llama.cpp at `1.9.2`.
