# Discord Presence Bot Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split health and bot metrics across Discord's Gateway activity name/state fields and include active owner reminder count.

**Architecture:** Add a focused reminder-count query to the reminder manager, extend the pure presence formatter to return name/state, and inject reminder counting into the existing serialized presence monitor. No Social SDK or RPC integration is introduced.

**Tech Stack:** TypeScript 7, Discord.js 14, Node.js test runner.

## Global Constraints

- Count only active, unnotified reminders for `OWNER_ID`.
- Keep activity name and state below 128 characters.
- Preserve 60-second serialized presence updates and uptime persistence.
- Keep Discord `online`/`idle` status driven by Pi-agent reachability.
- Never expose reminder text, IDs, user IDs, channel IDs, paths, or credentials.
- Release RemindMe as `2.3.3`; keep llama.cpp at `1.9.2`.

---

### Task 1: Active Owner Reminder Count

**Files:**

- Modify: `discord-pi-bot/src/utils/reminderManager.ts`
- Create: `discord-pi-bot/test/reminder-manager-count.test.ts`

- [ ] Add a failing test that creates immediate reminders for the owner and another user, asserts only the owner's reminder is counted, deletes it and asserts zero, then verifies a delivered reminder disappears from the count.
- [ ] Run `node --import tsx --test test/reminder-manager-count.test.ts` and verify RED.
- [ ] Export `getActiveReminderCount(userId: string): number` as `getReminders(userId).length`, returning zero for a blank user ID.
- [ ] Re-run the focused test and TypeScript typecheck; verify GREEN.
- [ ] Commit with `git commit -m "feat: count active owner reminders"`.

### Task 2: Activity Name and Metrics State

**Files:**

- Modify: `discord-pi-bot/src/presence.ts`
- Modify: `discord-pi-bot/test/presence.test.ts`

- [ ] Replace formatter expectations with `{ name, state }`, covering connected/offline names, singular/plural reminder labels, invalid count clamping, and 128-character limits.
- [ ] Extend monitor tests to prove reminder count is refreshed on every tick and count failures fall back to zero without stopping later updates.
- [ ] Run `node --import tsx --test test/presence.test.ts` and verify RED.
- [ ] Implement `formatPresenceActivity(connected, snapshot, reminderCount)` and pass its fields to `setPresence`.
- [ ] Add an injected `reminderCount` dependency whose default reads `getActiveReminderCount(process.env.OWNER_ID || "")`; catch failures with a generic log and use zero.
- [ ] Run focused tests, all TypeScript tests, UI tests, and typecheck; verify GREEN.
- [ ] Commit with `git commit -m "feat: show reminder metrics in bot presence"`.

### Task 3: RemindMe 2.3.3 Release

**Files:**

- Modify: `discord-pi-bot/config.yaml`
- Modify: `discord-pi-bot/README.md`
- Modify: `test/local-model-addon.test.mjs`

- [ ] Update packaging assertions to version `2.3.3` and require documentation of Gateway presence limitations plus name/state fields.
- [ ] Run `node --test test/local-model-addon.test.mjs` and verify RED.
- [ ] Bump the version and document the exact health/name and uptime/reminder state layout.
- [ ] Run all Node tests, typecheck, shell syntax, packaging tests, `git diff --check`, and ARM64 Docker build.
- [ ] Run redacted gitleaks and require zero findings.
- [ ] Commit with `git commit -m "feat: release bot data presence"` and push `feat/presence-bot-data`.
- [ ] Verify clean status and matching local/remote branch revisions.
