import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

test("settings contains only local harness preferences", () => {
	for (const field of ["profile", "glow", "scanlines"]) {
		assert.match(html, new RegExp(field), field);
	}
	for (const forbidden of [
		"discordToken",
		"ownerId",
		"piAgentWebhookUrl",
		"localLlmEnabled",
		"localLlmUrl",
		"localLlmModel",
		"localLlmContextSize",
		"localLlmVision",
		"modelManagerEnabled",
		"modelManagerUrl",
		"exaApiKey",
		"notifyTarget",
	]) {
		assert.doesNotMatch(html, new RegExp(`settings\\.${forbidden}`), forbidden);
	}
	assert.doesNotMatch(
		app,
		/api\/settings|settingsRevision|settingsChanges|saveSettings|restartSettingsAddon/,
	);
	for (const key of ["remindme.profile", "remindme.glow", "remindme.scanlines"]) {
		assert.match(app, new RegExp(`localStorage\\.setItem\\(\\"${key}`), key);
	}
});
