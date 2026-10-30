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
	for (const section of ["AI and sign-ins", "Your assistant", "What it may do", "Memory", "Skills", "Connectors", "Phone app", "Connected tools", "News", "Price watches", "Scheduled tasks", "Documents"])
		assert.match(app, new RegExp(`label: "${section}", group: `), section);
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

test("the installed app opens on a splash: iPhone launch images for every screen, and the same splash in the page", () => {
	const startups = [...html.matchAll(/rel="apple-touch-startup-image" media="\(device-width: (\d+)px\) and \(device-height: (\d+)px\) and \(-webkit-device-pixel-ratio: (\d)\)[^"]*" href="\.\/(splash\/splash-(\d+)x(\d+)\.png)"/g)];
	assert.ok(startups.length >= 10, `${startups.length} launch images`);
	for (const [, width, height, ratio, path, pixelsWide, pixelsHigh] of startups) {
		assert.equal(Number(pixelsWide), Number(width) * Number(ratio), path);
		assert.equal(Number(pixelsHigh), Number(height) * Number(ratio), path);
		const png = readFileSync(`public/${path}`);
		assert.equal(png.readUInt32BE(16), Number(pixelsWide), `${path} is as wide as its screen`);
		assert.equal(png.readUInt32BE(20), Number(pixelsHigh), `${path} is as tall as its screen`);
	}
	assert.match(html, /class="rm-splash" x-show="splash"/);
	assert.doesNotMatch(html, /<meta name="apple-mobile-web-app-status-bar-style"/, "any status bar style blurs the top of the installed app on iOS 26.1+");
	assert.match(app, /--app-height/);
	assert.match(readFileSync("public/styles.css", "utf8"), /@media \(display-mode: standalone\) \{\s*\.rm-splash/);
});

test("threads have cats, drawn by components/cats.js", () => {
	assert.match(html, /components\/cats\.js/);
	assert.ok(html.indexOf("components/cats.js") < html.indexOf("app.js\""), "cats.js loads before the console script");
	assert.match(html, /drawCat\(\$el, thread\.id/);
	assert.match(app, /catState\(thread\)/);
});

test("models are picked from a table that explains them, not a box of ids", () => {
	assert.match(html, /<table class="rm-models"/);
	assert.match(html, /Older and other models/);
	assert.match(html, /Or type a model's exact name/);
	assert.doesNotMatch(html, /datalist id="ai-models"/);
	assert.match(app, /pickModel\(id\)/);
});

test("only Claude Code and Codex remain as agents", () => {
	assert.doesNotMatch(html, /value="opencode"|value="pi"|Pi account/);
	assert.doesNotMatch(readFileSync("public/components/account-console.js", "utf8"), /agents\/pi|opencode/);
	const pkg = JSON.parse(readFileSync("package.json", "utf8"));
	assert.ok(!pkg.dependencies["opencode-ai"] && !pkg.dependencies["@earendil-works/pi-coding-agent"]);
});
