import assert from "node:assert/strict";
import test from "node:test";
import { allowedToolNames } from "../src/harness/intentRouting.ts";

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
