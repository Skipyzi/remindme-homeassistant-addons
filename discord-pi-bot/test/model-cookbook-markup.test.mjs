import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync("public/harness.html", "utf8");
const css = readFileSync("public/styles.css", "utf8");
const app = readFileSync("public/app.js", "utf8");
const component = readFileSync("public/components/model-cookbook.js", "utf8");

test("models use a dedicated download-only workbench", () => {
	assert.match(html, /@click="modelsOpen=true">Models/);
	assert.match(html, /id="models-view"[^>]*x-show="modelsOpen"/s);
	assert.match(html, /data-model-catalog/);
	assert.match(html, /@click="downloadModel\(variant\.model\.id\)"/);
	assert.match(html, /@click="cancelModelOperation\(\)"/);
	assert.match(html, /@click="copyModelYaml\(variant\.model\.id\)"/);
	assert.match(html, /@click="downloadModelYaml\(variant\.model\.id\)"/);
	assert.match(html, /variant\.verified/);
	assert.match(html, /Configuration/i);
	assert.match(html, /restart the llama\.cpp add-on/i);
	assert.doesNotMatch(html, /Install \+ activate|>Activate</i);
	assert.doesNotMatch(component, /\.\/api\/models\/activate|activate\(vm/);
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
