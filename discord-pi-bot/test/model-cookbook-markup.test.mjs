import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const app = readFileSync("public/app.js", "utf8");

test("hardware cookbook exposes secure model lifecycle controls", () => {
	assert.match(html, /components\/model-cookbook\.js/);
	assert.match(html, /data-model-catalog/);
	assert.match(html, /@click="installModel\(variant\.model\.id\)"/);
	assert.match(html, /@click="cancelModelOperation\(\)"/);
	assert.match(html, /type="password"[^>]*autocomplete="off"/s);
	assert.doesNotMatch(app, /localStorage.*hfToken/s);
});

test("model cards remain contained at narrow widths", () => {
	assert.match(
		css,
		/\.model-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*18rem\),\s*1fr\)\)/s,
	);
	assert.match(css, /\.model-card\s*\{[^}]*min-width:\s*0/s);
	assert.match(css, /\.model-card\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test("progress and errors have accessible live regions", () => {
	assert.match(html, /class="model-operation"[^>]*aria-live="polite"/s);
	assert.match(html, /class="model-error"[^>]*role="alert"/s);
});
