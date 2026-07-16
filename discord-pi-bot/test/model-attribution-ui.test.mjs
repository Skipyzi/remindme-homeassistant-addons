import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";

const require = createRequire(import.meta.url);
const timeline = require("../public/components/timeline.js");
const html = readFileSync("public/harness.html", "utf8");

test("completed answer retains generating model metrics", () => {
	let entries = timeline.applyHarnessEvent([], "answer_delta", {
		phaseId: "phase-1",
		text: "Answer",
	});
	entries = timeline.applyHarnessEvent(entries, "phase_complete", {
		phaseId: "phase-1",
		metrics: {
			modelId: "qwen3-4b-q4",
			modelName: "Qwen3 4B Q4_K_M",
			outputTokens: 4,
		},
	});
	assert.equal(entries[0].metrics.modelId, "qwen3-4b-q4");
	assert.equal(entries[0].metrics.modelName, "Qwen3 4B Q4_K_M");
});

test("answer footer renders optional model attribution", () => {
	assert.match(html, /message\.metrics\?\.modelName \|\| message\.metrics\?\.modelId/);
});
