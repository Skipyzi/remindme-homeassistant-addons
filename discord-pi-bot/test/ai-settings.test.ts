import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSettings } from "../src/ai/settings.ts";
import { SpendLedger, costOf } from "../src/ai/spend.ts";
import { legacyKeys, withLegacyKeys } from "../src/ai/legacyEndpoints.ts";
import { writeFileSync } from "node:fs";

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
	const settings = new AiSettings({ AI_PROVIDER: "claude", OPENAI_API_KEY: "o" }, path());
	assert.equal(settings.providerId(), "openai");
	assert.equal(settings.problem(), "Pick a model for OpenAI in RemindMe's AI settings.");
	const none = new AiSettings({ AI_PROVIDER: "openai" }, path());
	assert.match(none.problem(), /No AI is set up yet/);
	const other = new AiSettings({ AI_PROVIDER: "openai", ANTHROPIC_API_KEY: "a" }, path());
	assert.equal(other.providerId(), "claude", "falls back to the provider that has a key");
	assert.equal(none.provider(), undefined);
});

test("the console's choice is saved, and only providers with a key can be chosen", async () => {
	const file = path();
	const env = { AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
	const settings = new AiSettings(env, file);
	await settings.choose({ provider: "openai", model: "gpt-5.5", effort: "medium" });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { models: { openai: "gpt-5.5" }, provider: "openai", effort: "medium" });
	await assert.rejects(settings.choose({ provider: "chatgpt" }), /Sign in to that one first/);
	await assert.rejects(settings.choose({ provider: "opencode" }), /Unknown AI provider/, "OpenCode and custom servers are gone");
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

test("API keys saved by RemindMe 3.x fill blank options, and options win", () => {
	const file = path();
	writeFileSync(
		file,
		JSON.stringify({
			endpoints: [
				{ url: "http://homeassistant:8080/v1/chat/completions", model: "qwen3" },
				{ url: "https://api.openai.com/v1/responses", authProvider: "chatgpt", model: "gpt-5.5" },
				{ url: "https://api.anthropic.com/v1/messages", apiKey: "sk-ant-old" },
				{ url: "https://opencode.ai/zen/go/v1/chat/completions", apiKey: "oc-old", model: "glm" },
				{ url: "https://openrouter.ai/api/v1/chat/completions", apiKey: "or-old" },
			],
		}),
	);
	assert.deepEqual(legacyKeys(file), { CHATGPT_MODEL: "gpt-5.5", ANTHROPIC_API_KEY: "sk-ant-old" }, "OpenCode, other servers and the local llama.cpp are left behind");
	const env = withLegacyKeys({ ANTHROPIC_API_KEY: "sk-ant-new" }, file);
	assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-new", "options win");
	assert.equal(env.CHATGPT_MODEL, "gpt-5.5");
	assert.deepEqual(legacyKeys(join(tmpdir(), "missing-endpoints.json")), {});
});

test("a thread or a chore can have a model of its own, from the providers that are set up", () => {
	const settings = new AiSettings({ AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }, path());
	const groups = settings.choices();
	assert.deepEqual(groups.map((group) => group.provider), ["claude", "openai"]);
	assert.deepEqual(groups[0].models.map((model) => model.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
	assert.equal(groups[0].models[3].name, "Claude Haiku 5.5");

	assert.deepEqual(settings.checkChoice({ provider: "claude", model: "claude-haiku-5-5" }), { provider: "claude", model: "claude-haiku-5-5" });
	assert.equal(settings.checkChoice({ provider: "chatgpt", model: "gpt-6-luna" }), undefined, "not signed in");
	assert.equal(settings.checkChoice({ provider: "claude", model: "haiku; rm -rf" }), undefined);
	assert.equal(settings.checkChoice({ provider: "nope", model: "x" }), undefined);
	assert.equal(settings.checkChoice(null), undefined);
	assert.equal(settings.choiceName({ provider: "claude", model: "claude-haiku-5-5" }), "Claude Haiku 5.5");

	const haiku = settings.pick({ provider: "claude", model: "claude-haiku-5-5" });
	assert.equal(haiku.provider?.model, "claude-haiku-5-5");
	assert.equal(settings.pick({ provider: "claude", model: "claude-haiku-5-5" }).provider, haiku.provider, "built once");
	assert.equal(settings.pick().provider?.model, "claude-opus-5-5", "no choice: the default");
	assert.equal(settings.pick({ provider: "chatgpt", model: "gpt-6-luna" }).provider?.model, "claude-opus-5-5", "a provider that isn't set up: the default");
});
