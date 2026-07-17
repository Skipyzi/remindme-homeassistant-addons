import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

test("restart-required settings expose an explicit restart control", () => {
	assert.match(html, /settingsRestartRequired/);
	assert.match(html, /restartSettingsAddon\(\)/);
	assert.match(html, /Restart add-on/);
});

test("restart waits for a different process instance before reload", () => {
	assert.match(app, /\.\/api\/settings\/restart/);
	assert.match(app, /previousInstanceId/);
	assert.match(app, /status\.instanceId !== previousInstanceId/);
	assert.match(app, /window\.location\.reload\(\)/);
	assert.match(app, /60_000/);
});
