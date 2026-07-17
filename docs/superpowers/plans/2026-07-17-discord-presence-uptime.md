# Discord Presence Lifetime Uptime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display cumulative bot uptime and lifetime availability in Discord presence using a persistent heartbeat tracker.

**Architecture:** Add a focused persistence module with injected clock/session dependencies for deterministic tests, then make the presence monitor asynchronously initialize and serialize heartbeat updates. Keep reachability and display formatting separate from file I/O.

**Tech Stack:** TypeScript 7, Node.js 22 filesystem APIs, Discord.js 14, Node test runner, POSIX shell.

## Global Constraints

- Persist under `/data/presence-uptime.json` with atomic replacement and mode `0600`.
- Count every stopped gap as downtime.
- Never store or log Discord, Supervisor, Pi-agent, Exa, or model credentials.
- Keep the activity-state string below 128 characters.
- Preserve Pi bridge online/idle status behavior.
- Use `pnpm` where package commands are needed.
- Release RemindMe as `2.3.2`; keep managed llama.cpp at `1.9.2`.

---

### Task 1: Persistent Lifetime Uptime Tracker

**Files:**

- Create: `discord-pi-bot/src/presenceUptime.ts`
- Create: `discord-pi-bot/test/presence-uptime.test.ts`

**Interfaces:**

- `PresenceUptimeTracker.initialize(): Promise<UptimeSnapshot>`
- `PresenceUptimeTracker.sample(): Promise<UptimeSnapshot>`
- `UptimeSnapshot = { totalOnlineMs: number; availabilityPercent: number; trackingStartedAt: number; lastHeartbeatAt: number }`
- Constructor accepts path plus optional injected `now`, `sessionId`, and safe error logger.

- [ ] **Step 1: Add failing first-run and same-session tests**

Use a temporary path and mutable fake clock. Assert initialization reports `0` ms and `100%`, creates valid versioned JSON, and uses mode `0600` on non-Windows. Advance 90 seconds, sample, and assert `90_000` online ms and `100%`.

- [ ] **Step 2: Add failing restart-gap test**

Initialize session A at `0`, sample at `60_000`, then initialize session B at `360_000` and sample at `420_000`. Assert total uptime is `120_000`, the six-minute stopped gap was not credited, and availability is `120_000 / 420_000 * 100`.

- [ ] **Step 3: Add failing corruption and backward-time tests**

Write invalid JSON, initialize, and assert a `.corrupt` sibling exists and fresh tracking begins. Move the fake clock backward and assert no negative time is credited. Add an invalid version/future timestamp case.

- [ ] **Step 4: Run focused tests to verify RED**

```bash
cd discord-pi-bot
node --import tsx --test test/presence-uptime.test.ts
```

Expected: FAIL because the tracker module does not exist.

- [ ] **Step 5: Implement validation, sampling, and atomic persistence**

Create a version-1 state type and strict validator. On initialization, load valid state or quarantine corrupt state; generate the new session ID and heartbeat without crediting the gap. On sample, credit only `max(0, now - lastSampleAt)`. Calculate availability from accumulated uptime over wall-clock tracking lifetime, returning 100 for zero lifetime.

Atomic writes must create the parent directory, use a unique temporary file with `wx` and `0600`, write and sync through a file handle, close, rename, chmod the final path, and clean up the temporary file on failure. Persistence errors call the safe logger and retain in-memory state rather than throwing.

- [ ] **Step 6: Run focused test and typecheck**

```bash
node --import tsx --test test/presence-uptime.test.ts
../../../node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Expected: all tests and typecheck pass.

- [ ] **Step 7: Commit**

```bash
git add discord-pi-bot/src/presenceUptime.ts discord-pi-bot/test/presence-uptime.test.ts
git commit -m "feat: persist lifetime bot uptime"
```

---

### Task 2: Rich Presence and Non-overlapping Monitor

**Files:**

- Modify: `discord-pi-bot/src/presence.ts`
- Modify: `discord-pi-bot/src/index.ts`
- Create: `discord-pi-bot/test/presence.test.ts`

**Interfaces:**

- `formatPresenceDuration(totalOnlineMs: number): string`
- `formatPresenceState(connected: boolean, snapshot: UptimeSnapshot): string`
- `updatePresence(client, snapshot, reachable?)`
- `startPresenceMonitor(client, dependencies?): Promise<NodeJS.Timeout>`

- [ ] **Step 1: Add failing formatter tests**

Assert durations `0m`, `47m`, `3h 8m`, and `12d 4h`. Assert connected/offline states include `Up`, two-decimal clamped availability, and `!help`, and remain below 128 characters.

- [ ] **Step 2: Add failing monitor serialization test**

Inject a fake tracker, reachability function, and scheduler. Capture the scheduled callback. After the initial awaited update, invoke the callback twice while the first fake sample remains pending. Assert only one sample/update runs until it settles.

- [ ] **Step 3: Run focused tests to verify RED**

```bash
node --import tsx --test test/presence.test.ts
```

Expected: FAIL because formatters and asynchronous monitor dependencies do not exist.

- [ ] **Step 4: Implement presence formatting and serialized ticks**

Format activity state as `Pi connected|offline • Up <duration> • <percentage>% • !help`. `startPresenceMonitor` creates or accepts a tracker using `PRESENCE_UPTIME_PATH || /data/presence-uptime.json`, awaits initialization, performs the first update, and schedules 60-second ticks. Guard ticks with a boolean and clear it in `finally` so slow network/file operations never overlap.

Keep `ActivityType.Watching`, Discord `online` when the bridge responds, and `idle` otherwise. Log persistence/reachability errors without credentials. In `index.ts`, await `startPresenceMonitor(client)` inside the existing async ready callback.

- [ ] **Step 5: Run focused tests and complete Node gates**

```bash
node --import tsx --test test/presence.test.ts test/presence-uptime.test.ts
node --import tsx --test test/*.test.ts
node --test test/*.test.mjs
../../../node_modules/.bin/tsc -p tsconfig.json --noEmit
```

Expected: every command passes.

- [ ] **Step 6: Commit**

```bash
git add discord-pi-bot/src/presence.ts discord-pi-bot/src/index.ts discord-pi-bot/test/presence.test.ts
git commit -m "feat: show lifetime uptime in Discord presence"
```

---

### Task 3: Package and Release RemindMe 2.3.2

**Files:**

- Modify: `discord-pi-bot/run.sh`
- Modify: `discord-pi-bot/config.yaml`
- Modify: `discord-pi-bot/README.md`
- Modify: `test/local-model-addon.test.mjs`

**Interfaces:**

- Export `PRESENCE_UPTIME_PATH=/data/presence-uptime.json`.
- Release RemindMe `2.3.2`.

- [ ] **Step 1: Add failing packaging assertions**

Update expected RemindMe version to `2.3.2`. Assert `run.sh` exports the uptime path and README explains tracking start, cumulative uptime, lifetime percentage, and that every stopped gap counts as downtime.

- [ ] **Step 2: Run packaging test to verify RED**

```bash
node --test test/local-model-addon.test.mjs
```

Expected: FAIL on old version and missing uptime packaging/docs.

- [ ] **Step 3: Update package and documentation**

Bump `discord-pi-bot/config.yaml`, export the path after `REMINDER_DATA_PATH`, and add an operator section with the exact display semantics and reset procedure (stop add-on and delete only `/data/presence-uptime.json`).

- [ ] **Step 4: Run complete release gates**

```bash
cd discord-pi-bot
node --import tsx --test test/*.test.ts
node --test test/*.test.mjs
../../../node_modules/.bin/tsc -p tsconfig.json --noEmit
node --check public/app.js
cd ..
node --test test/*.test.mjs
sh -n discord-pi-bot/run.sh
git diff --check
docker build --platform linux/arm64 -t remindme-discord-bot:2.3.2 discord-pi-bot
```

Expected: all commands exit zero and the ARM64 image builds.

- [ ] **Step 5: Run redacted secret scan**

Run gitleaks against the repository and require zero findings.

- [ ] **Step 6: Commit and push**

```bash
git add discord-pi-bot test
git commit -m "feat: release persistent presence uptime"
git push -u origin feat/presence-uptime
```

- [ ] **Step 7: Confirm clean synchronized branch**

```bash
git status --short
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/feat/presence-uptime)"
```

Expected: clean status and equal revisions.
