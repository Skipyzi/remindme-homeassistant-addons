import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

test("the console is the ledger: command line, waiting on you, and the timeline", () => {
	assert.match(html, /class="rm-ask"/);
	assert.match(html, /aria-label="Waiting on you"/);
	assert.match(html, /class="rm-ledger"/);
	assert.match(html, /class="rm-now"/);
	for (const tab of ["Everything", "Coming up", "What it did", "Messages"]) assert.match(app, new RegExp(`label: "${tab}"`));
	assert.match(app, /fetch\("\.\/api\/ledger"/);
	assert.match(app, /"\.\/api\/chat"/);
});

test("the old dev-harness pieces are gone from the page", () => {
	for (const gone of ["tok/s", "first signal", "Model instruments", "scanlines", "artifact-panel", "thinking-select", "model-cookbook", "endpoints.js"])
		assert.doesNotMatch(html, new RegExp(gone), gone);
});

test("settings keep every section, including the 3.1 sign-in console", () => {
	for (const section of ["AI and sign-ins", "How it talks", "Skills", "Connected tools", "Scheduled tasks", "Documents"])
		assert.match(app, new RegExp(`label: "${section}"`), section);
	assert.match(html, /id="account-terminal"/);
	assert.match(html, /components\/account-console\.js/);
});

test("answers render through the DOM-building markdown renderer, never as HTML", () => {
	assert.match(app, /RemindMeRichText\.render\(element, text\)/);
	assert.doesNotMatch(app, /innerHTML/);
	assert.doesNotMatch(html, /x-html/);
});
