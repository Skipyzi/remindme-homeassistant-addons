import assert from "node:assert/strict";
import test from "node:test";
import { modelTable } from "../src/ai/catalog.ts";

const CLAUDE_LISTED = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"];

test("Claude's current models lead, explained and priced; the rest are older", () => {
	const table = modelTable("claude", CLAUDE_LISTED, 6);
	assert.equal(table.billing, "credits");
	assert.deepEqual(table.featured.map((model) => model.id), ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], "best first, whatever order the API lists them in");
	assert.deepEqual(table.others, ["claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"]);
	const [fable, opus, sonnet, haiku] = table.featured;
	assert.equal(opus.recommended, true);
	assert.ok(opus.perAnswerUsd! > 0.03 && opus.perAnswerUsd! < 0.05, `Opus about 4¢ an answer, got ${opus.perAnswerUsd}`);
	assert.ok(fable.perAnswerUsd! > opus.perAnswerUsd! && opus.perAnswerUsd! > sonnet.perAnswerUsd! && sonnet.perAnswerUsd! > haiku.perAnswerUsd!, "dearer models cost more an answer");
	assert.ok(haiku.perAnswerUsd! < 0.002);
	assert.equal(opus.perDay, Math.floor(6 / opus.perAnswerUsd!));
	assert.equal(modelTable("claude", CLAUDE_LISTED, 0).featured[0].perDay, undefined, "no budget, no answers-a-day figure");
});

test("a model the account can't use isn't offered", () => {
	const table = modelTable("claude", ["claude-sonnet-5-5", "claude-haiku-5-5"], 2);
	assert.deepEqual(table.featured.map((model) => model.id), ["claude-sonnet-5-5", "claude-haiku-5-5"]);
	assert.deepEqual(table.others, []);
});

test("subscriptions show plan use, the OpenAI API shows no price, unknown providers list everything", () => {
	const chatgpt = modelTable("chatgpt", ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"], 6);
	assert.equal(chatgpt.billing, "plan");
	assert.deepEqual(chatgpt.featured.map((model) => [model.id, model.plan, model.perAnswerUsd]), [["gpt-6-astra", 3, undefined], ["gpt-6.1-sol", 2, undefined], ["gpt-6-luna", 1, undefined]]);
	assert.deepEqual(chatgpt.others, ["gpt-6.1-terra", "gpt-6-sol", "gpt-5.6-sol"], "a model without a confirmed description waits under Older");
	const openai = modelTable("openai", ["gpt-6.1-sol"], 6);
	assert.equal(openai.billing, "unknown");
	assert.equal(openai.featured[0].plan, undefined);
	assert.deepEqual(modelTable("openai", ["gpt-7-preview"], 6), { billing: "unknown", budget: 6, featured: [], others: ["gpt-7-preview"] }, "a model the catalogue doesn't know yet still shows");
	assert.deepEqual(modelTable("claude-code", ["sonnet", "opus", "haiku"], 6).featured.map((model) => [model.id, model.recommended ?? false]), [["opus", false], ["sonnet", true], ["haiku", false]]);
});
