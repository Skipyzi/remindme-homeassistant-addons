import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const component = readFileSync("public/components/model-cookbook.js", "utf8");

test("unpaired model vault exposes a one-time code form", () => {
	assert.match(html, /modelPairingConfigured/);
	assert.match(html, /pairingCode/);
	assert.match(html, /pairModelManager\(\)/);
	assert.match(html, /six-character code/i);
});

test("pairing code is cleared and never persisted", () => {
	assert.match(component, /vm\.pairingCode = ""/);
	assert.match(component, /\.\/api\/models\/pairing/);
	assert.match(component, /\.\/api\/models\/pair/);
	assert.doesNotMatch(component, /localStorage.*pairing/i);
});
