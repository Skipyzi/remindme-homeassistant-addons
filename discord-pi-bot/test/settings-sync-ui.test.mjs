import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

test("settings form mirrors every safe add-on schema field", () => {
	for (const model of [
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
		assert.match(html, new RegExp(`settings\\.${model}`), model);
	}
	assert.match(html, /discordTokenConfigured/);
	assert.match(html, /exaApiKeyConfigured/);
});

test("settings save sends revisioned changes and handles conflicts", () => {
	assert.match(app, /settingsRevision/);
	assert.match(app, /settingsChanges\(\)/);
	assert.match(app, /JSON\.stringify\(\{\s*revision:/s);
	assert.match(app, /configuration_changed/);
	assert.match(app, /restartRequired/);
});

test("secret replacement values are cleared after save", () => {
	assert.match(app, /settings\.discordToken = ""/);
	assert.match(app, /settings\.exaApiKey = ""/);
});
