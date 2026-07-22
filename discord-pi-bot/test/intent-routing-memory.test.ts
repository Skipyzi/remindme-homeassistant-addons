import assert from "node:assert/strict";
import test from "node:test";
import { allowedToolNames } from "../src/harness/intentRouting.ts";

test("memory phrasing exposes the memory tools", () => {
	for (const prompt of [
		"remember that I take my coffee black",
		"what did we decide last week?",
		"add a note about the vault",
		"recall my project preferences",
	]) {
		const allowed = allowedToolNames(prompt);
		assert.ok(allowed.has("search_memory"), prompt);
		assert.ok(allowed.has("read_memory"), prompt);
		assert.ok(allowed.has("write_memory"), prompt);
	}
});

test("unrelated phrasing does not pull in memory tools", () => {
	const allowed = allowedToolNames("turn on the kitchen light");
	assert.ok(!allowed.has("write_memory"));
	// Home terms still route to entity tools.
	assert.ok(allowed.has("control_entity"));
});
