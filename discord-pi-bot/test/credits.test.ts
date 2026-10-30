import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AnthropicCosts, CreditSettings, creditsView, cycleFor, modelLabel, readCostReport } from "../src/ai/credits.ts";
import { SpendLedger, costOf } from "../src/ai/spend.ts";

const dir = () => mkdtempSync(join(tmpdir(), "credits-"));
const usage = (inputTokens: number, webSearches = 0) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...(webSearches ? { webSearches } : {}) });

test("a credit month runs from the renewal day to the next, and the 31st is the last day of a short month", () => {
	assert.deepEqual(cycleFor(new Date(2026, 9, 30, 9), 14), { start: "2026-10-14", end: "2026-11-14", days: 31, day: 17, daysLeft: 14 });
	assert.deepEqual(cycleFor(new Date(2026, 9, 10, 9), 14), { start: "2026-09-14", end: "2026-10-14", days: 30, day: 27, daysLeft: 3 });
	assert.deepEqual(cycleFor(new Date(2026, 9, 30, 9), null), { start: "2026-10-01", end: "2026-11-01", days: 31, day: 30, daysLeft: 1 });
	assert.equal(cycleFor(new Date(2026, 1, 28, 9), 31).start, "2026-02-28", "February has no 31st");
	assert.equal(cycleFor(new Date(2026, 2, 5, 9), 31).end, "2026-03-31");
	assert.equal(cycleFor(new Date(2026, 9, 14, 0, 5), 14).day, 1, "the renewal day itself starts the month");
});

test("the plan keeps the allowance and day, and refuses nonsense", async () => {
	const path = join(dir(), "credits.json");
	const plan = new CreditSettings(path);
	await plan.load();
	assert.deepEqual(plan.get(), { allowance: 200, renewDay: null });
	await plan.set({ renewDay: 14 });
	await assert.rejects(plan.set({ renewDay: 40 }), /1 to 31/);
	await assert.rejects(plan.set({ allowance: -5 }), /dollars/);
	const again = new CreditSettings(path);
	await again.load();
	assert.deepEqual(again.get(), { allowance: 200, renewDay: 14 });
	await again.set({ renewDay: null });
	assert.equal(again.get().renewDay, null);
});

test("Anthropic's cost report is read in cents, per day, model and kind", () => {
	const costs = readCostReport([
		{
			data: [
				{ starting_at: "2026-10-14T00:00:00Z", results: [{ amount: "250.5", cost_type: "tokens", model: "claude-opus-5-5" }, { amount: "10", cost_type: "web_search", model: null }] },
				{ starting_at: "2026-10-15T00:00:00Z", results: [] },
			],
			has_more: true,
		},
		{ data: [{ starting_at: "2026-10-16T00:00:00Z", results: [{ amount: "40", cost_type: "tokens", model: "claude-haiku-5-5" }, { amount: "60", cost_type: "tokens", model: "claude-opus-5-5" }] }] },
	]);
	assert.equal(Math.round(costs.usd * 1000) / 1000, 3.605);
	assert.deepEqual(costs.perDay, { "2026-10-14": 2.605, "2026-10-16": 1 });
	assert.deepEqual(
		costs.parts.map((part) => [part.label, Math.round(part.usd * 1000) / 1000]),
		[["Opus 5.5", 3.105], ["Haiku 5.5", 0.4], ["Web searches", 0.1]],
	);
	assert.equal(modelLabel("claude-sonnet-4-6-20260101"), "Sonnet 4.6");
	assert.equal(modelLabel("claude-fable-5"), "Fable 5");
});

test("the ledger keeps a month of days, and reads the one-day file of 4.31", async () => {
	const path = join(dir(), "spend.json");
	writeFileSync(path, JSON.stringify({ date: "2026-10-30", usd: 1.5, inputTokens: 10, outputTokens: 5, runs: 2, unpriced: false }));
	const ledger = new SpendLedger(path);
	await ledger.load();
	assert.equal(ledger.today(new Date(2026, 9, 30, 12)).usd, 1.5, "today's spend survives the upgrade");
	await ledger.record("claude-opus-5-5", usage(1_000_000, 3), new Date(2026, 9, 31, 9));
	const later = new SpendLedger(path);
	await later.load();
	const days = later.between("2026-10-30", "2026-11-01");
	assert.deepEqual(days.map((day) => day.date), ["2026-10-30", "2026-10-31"]);
	assert.equal(days[1].usd, 4.03, "tokens plus three web searches at a cent each");
	assert.deepEqual(days[1].byModel, { "claude-opus-5-5": 4 });
	assert.equal(days[1].webSearches, 3);
	assert.equal(costOf("claude-haiku-5-5", usage(0, 10)), 0.1);
});

test("without an Admin key the page shows RemindMe's own count, from when it started counting", async () => {
	const ledger = new SpendLedger(join(dir(), "spend.json"));
	await ledger.record("claude-opus-5-5", usage(1_000_000), new Date(2026, 9, 29, 9));
	await ledger.record("claude-haiku-5-5", usage(1_000_000, 2), new Date(2026, 9, 30, 9));
	const costs = new AnthropicCosts(() => "");
	const view = await creditsView({ plan: { allowance: 200, renewDay: 14 }, spend: ledger, anthropic: costs, dailyCap: 20, now: new Date(2026, 9, 30, 18) });
	assert.equal(view.source, "estimate");
	assert.equal(view.anthropic, null);
	assert.equal(Math.round(view.used * 100) / 100, 4.12);
	assert.equal(view.perDay.length, 17);
	assert.deepEqual(view.perDay.slice(-2).map((day) => Math.round(day.usd * 100) / 100), [4, 0.12]);
	assert.deepEqual(view.estimate.since, "2026-10-29");
	assert.deepEqual(view.parts.map((part) => part.label), ["Opus 5.5", "Haiku 5.5", "Web searches"]);
	assert.equal(Math.round(view.pace * 100) / 100, Math.round((4.12 / 17) * 31 * 100) / 100);
});

test("with an Admin key it asks Anthropic once in ten minutes, and says what went wrong", async () => {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	let status = 200;
	const fake = (async (url: string, init?: { headers?: Record<string, string> }) => {
		calls.push({ url, headers: init?.headers || {} });
		if (status !== 200) return new Response(JSON.stringify({ error: { message: "nope" } }), { status });
		return Response.json({ data: [{ starting_at: "2026-10-30T00:00:00Z", results: [{ amount: "3840", cost_type: "tokens", model: "claude-opus-5-5" }] }], has_more: false, next_page: null });
	}) as unknown as typeof fetch;
	const costs = new AnthropicCosts(() => "sk-ant-admin01-test", fake);
	const ledger = new SpendLedger(join(dir(), "spend.json"));
	const now = new Date(2026, 9, 30, 18);
	const view = await creditsView({ plan: { allowance: 200, renewDay: 14 }, spend: ledger, anthropic: costs, dailyCap: 20, now });
	assert.equal(view.source, "anthropic");
	assert.equal(view.used, 38.4);
	assert.equal(view.anthropic?.ok, true);
	assert.match(calls[0].url, /cost_report\?starting_at=2026-10-14T00%3A00%3A00Z&bucket_width=1d&limit=31&group_by%5B%5D=description/);
	assert.equal(calls[0].headers["x-api-key"], "sk-ant-admin01-test");
	await creditsView({ plan: { allowance: 200, renewDay: 14 }, spend: ledger, anthropic: costs, dailyCap: 20, now });
	assert.equal(calls.length, 1, "cached");

	status = 401;
	const failing = new AnthropicCosts(() => "sk-ant-admin01-bad", fake);
	const fallback = await creditsView({ plan: { allowance: 200, renewDay: 14 }, spend: ledger, anthropic: failing, dailyCap: 20, now });
	assert.equal(fallback.source, "estimate");
	assert.match(fallback.anthropic?.error || "", /didn't accept the Admin key/);
	assert.ok(!JSON.stringify(fallback).includes("sk-ant-admin01"), "the key never reaches the page");
});
