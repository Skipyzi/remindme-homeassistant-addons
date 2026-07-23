import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const app = readFileSync("public/app.js", "utf8");
const component = readFileSync("public/components/model-cookbook.js", "utf8");

test("models support one-click switching with a YAML fallback", () => {
	assert.match(html, /@click="modelsOpen=true">Models/);
	assert.match(html, /id="models-view"[^>]*x-show="modelsOpen"/s);
	assert.match(html, /data-model-catalog/);
	// The primary action is now "use" — download+verify+activate, or hot-swap.
	assert.match(html, /@click="useModel\(variant\.model\.id\)"/);
	assert.match(html, /Download &amp; use/);
	assert.match(html, /Use this model/);
	assert.match(html, /@click="cancelModelOperation\(\)"/);
	// Copy YAML stays as the advanced fallback path.
	assert.match(html, /@click="copyModelYaml\(variant\.model\.id\)"/);
	assert.match(html, /variant\.verified/);
	assert.match(html, /Configuration/i);
	assert.match(html, /restart the llama\.cpp add-on/i);
	// The switch client hits the activate endpoint and orchestrates use().
	assert.match(component, /\.\/api\/models\/activate/);
	assert.match(component, /use\(vm, id\)/);
	assert.match(app, /useModel\(id\)/);
	assert.doesNotMatch(app, /localStorage.*modelYaml/s);
});

test("model cards and YAML remain contained at narrow widths", () => {
	assert.match(
		css,
		/\.model-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*18rem\),\s*1fr\)\)/s,
	);
	assert.match(css, /\.model-card\s*\{[^}]*min-width:\s*0/s);
	assert.match(css, /\.model-card\s*\{[^}]*overflow-wrap:\s*anywhere/s);
	assert.match(css, /\.model-yaml/);
});

test("progress and errors have accessible live regions", () => {
	assert.match(html, /class="model-operation"[^>]*aria-live="polite"/s);
	assert.match(html, /class="model-error"[^>]*role="alert"/s);
});
