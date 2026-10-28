import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const app = readFileSync("public/app.js", "utf8");

test("the console is an inbox: needs you, working on, threads, and the ledger as History", () => {
	assert.match(html, /class="rm-inbox"/);
	assert.match(html, /aria-label="Needs you"/);
	assert.match(html, /aria-label="Working on"/);
	assert.match(html, /class="rm-compose"/);
	assert.match(html, /class="rm-thread"/);
	assert.match(html, /id="history-title"/);
	assert.match(html, /class="rm-ledger"/);
	assert.match(html, /class="rm-now"/);
	for (const tab of ["Everything", "Coming up", "What it did", "Messages"]) assert.match(app, new RegExp(`label: "${tab}"`));
	assert.match(app, /fetch\("\.\/api\/inbox"/);
	assert.match(app, /"\.\/api\/threads"/);
	assert.match(app, /"\.\/api\/ledger"/);
	assert.doesNotMatch(app, /"\.\/api\/chat"/, "the single console chat is gone; every request is a thread");
});

test("the old dev-harness pieces are gone from the page", () => {
	for (const gone of ["tok/s", "first signal", "Model instruments", "scanlines", "artifact-panel", "thinking-select", "model-cookbook", "endpoints.js"])
		assert.doesNotMatch(html, new RegExp(gone), gone);
});

test("settings keep every section, including the 3.1 sign-in console", () => {
	for (const section of ["AI and sign-ins", "Connectors", "Phone app", "How it talks", "Skills", "Connected tools", "Scheduled tasks", "Documents"])
		assert.match(app, new RegExp(`label: "${section}"`), section);
	assert.match(html, /id="account-terminal"/);
	assert.match(html, /components\/account-console\.js/);
});

test("answers render through the DOM-building markdown renderer, never as HTML", () => {
	assert.match(app, /RemindMeRichText\.render\(element, text\)/);
	assert.doesNotMatch(app, /innerHTML/);
	assert.doesNotMatch(html, /x-html/);
});

test("the console installs as a phone app with its own notifications", () => {
	const manifest = JSON.parse(readFileSync("public/manifest.webmanifest", "utf8"));
	assert.equal(manifest.display, "standalone");
	assert.equal(manifest.start_url, "./");
	assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
	for (const icon of manifest.icons) assert.ok(readFileSync(`public/${icon.src}`).length > 500, icon.src);
	assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
	assert.match(html, /rel="apple-touch-icon"/);
	const worker = readFileSync("public/sw.js", "utf8");
	assert.match(worker, /addEventListener\("push"/);
	assert.match(worker, /addEventListener\("notificationclick"/);
	assert.match(worker, /includes\("\/api\/"\)/, "the API is never cached");
	assert.match(app, /serviceWorker\.register\("\.\/sw\.js"\)/);
	assert.match(app, /hassio_ingress/, "no service worker inside the Home Assistant panel");
});
