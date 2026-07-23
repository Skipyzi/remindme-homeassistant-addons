import assert from "node:assert/strict";
import test from "node:test";
import {
	allowedToolNames,
	detectPositiveFeedback,
} from "../src/harness/intentRouting.ts";

test("memory tools are always in reach — long-term memory is not gated", () => {
	for (const prompt of [
		"remember that I take my coffee black",
		"what did we decide last week?",
		"turn on the kitchen light",
		"how tall is Mount Everest?",
	]) {
		const allowed = allowedToolNames(prompt);
		assert.ok(allowed.has("search_memory"), prompt);
		assert.ok(allowed.has("read_memory"), prompt);
		assert.ok(allowed.has("write_memory"), prompt);
	}
});

test("other intents still route alongside memory", () => {
	const allowed = allowedToolNames("turn on the kitchen light");
	// Home terms still route to entity tools, on top of the always-on memory.
	assert.ok(allowed.has("control_entity"));
});

test("short acknowledgements cue a memory capture", () => {
	for (const prompt of [
		"that worked",
		"perfect, that fixed it",
		"thanks, works now",
		"nice one",
	])
		assert.ok(detectPositiveFeedback(prompt), prompt);
});

test("a request that merely opens with thanks is not a capture cue", () => {
	for (const prompt of [
		"thanks, now build me a dashboard with charts, tables and a graph view",
		"turn on the kitchen light",
		"the code worked yesterday but broke after I refactored the whole module",
	])
		assert.ok(!detectPositiveFeedback(prompt), prompt);
});
