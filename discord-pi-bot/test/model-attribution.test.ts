import assert from "node:assert/strict";
import test from "node:test";
import { normalizePhaseMetrics } from "../src/harness/modelPhases";

test("phase metrics retain the generating model", () => {
	const metrics = normalizePhaseMetrics(
		{ prompt_tokens: 10, completion_tokens: 4 },
		{},
		12,
		90,
		0,
		{ modelId: "qwen3-4b-q4", modelName: "Qwen3 4B Q4_K_M" },
	);
	assert.equal(metrics.modelId, "qwen3-4b-q4");
	assert.equal(metrics.modelName, "Qwen3 4B Q4_K_M");
});
