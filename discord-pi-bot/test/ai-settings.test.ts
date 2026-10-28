import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSettings } from "../src/ai/settings.ts";
import { SpendLedger, costOf } from "../src/ai/spend.ts";

const path = () => join(mkdtempSync(join(tmpdir(), "ai-")), "ai.json");

test("Claude with a key works out of the box on Opus 5.5", () => {
	const settings = new AiSettings({ AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "sk-ant-secret" }, path());
	const status = settings.status(false);
	assert.equal(status.ready, true);
	assert.equal(status.model, "claude-opus-5-5");
	assert.equal(status.webSearch, "provider");
	assert.equal(settings.provider()?.label, "Claude");
	assert.ok(!JSON.stringify(status).includes("sk-ant-secret"), "keys never leave the server");
});

test("without a key for the chosen provider, the first one with a key answers", () => {
	const settings = new AiSettings({ AI_PROVIDER: "claude", OPENCODE_API_KEY: "oc" }, path());
	assert.equal(settings.providerId(), "opencode");
	assert.equal(settings.problem(), "Pick a model for OpenCode in RemindMe's AI settings.");
	const none = new AiSettings({ AI_PROVIDER: "openai" }, path());
	assert.match(none.problem(), /No OpenAI API key is set/);
	assert.equal(none.provider(), undefined);
});

test("the console's choice is saved, and only providers with a key can be chosen", async () => {
	const file = path();
	const env = { AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
	const settings = new AiSettings(env, file);
	await settings.choose({ provider: "openai", model: "gpt-5.5", effort: "medium" });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { models: { openai: "gpt-5.5" }, provider: "openai", effort: "medium" });
	await assert.rejects(settings.choose({ provider: "opencode" }), /no API key/);
	await assert.rejects(settings.choose({ effort: "max" }), /low, medium or high/);
	const reloaded = new AiSettings(env, file);
	await reloaded.load();
	assert.equal(reloaded.providerId(), "openai");
	assert.equal(reloaded.model(), "gpt-5.5");
	assert.equal(reloaded.model("claude"), "claude-opus-5-5");
	assert.equal(reloaded.effort(), "medium");
});

test("a blank budget option means the default, and 0 means no cap", () => {
	assert.equal(new AiSettings({ DAILY_AI_BUDGET: "" }, path()).dailyBudget(), 2);
	assert.equal(new AiSettings({ DAILY_AI_BUDGET: "0" }, path()).dailyBudget(), 0);
	assert.equal(new AiSettings({ DAILY_AI_BUDGET: "5.5" }, path()).dailyBudget(), 5.5);
});

test("spend is priced for Claude, counted for the rest, and resets each day", async () => {
	assert.equal(costOf("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }), 4 + 2 + 0.2);
	assert.equal(costOf("gpt-5.5", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), undefined);
	const ledger = new SpendLedger(path());
	const morning = new Date("2026-10-28T08:00:00");
	await ledger.record("claude-opus-5-5", { inputTokens: 500_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, morning);
	await ledger.record("muse-spark", { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, morning);
	assert.equal(ledger.today(morning).usd, 2);
	assert.equal(ledger.today(morning).unpriced, true);
	assert.equal(ledger.overBudget(2, morning), true);
	assert.equal(ledger.overBudget(0, morning), false);
	assert.equal(ledger.overBudget(2, new Date("2026-10-29T08:00:00")), false);
});
