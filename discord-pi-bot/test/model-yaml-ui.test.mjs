import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync("public/components/model-cookbook.js", "utf8");

test("YAML copy uses the server recipe and reports clipboard denial", () => {
	assert.match(component, /\.\/api\/models\/\$\{encodeURIComponent\(id\)\}\/options\.yaml/);
	assert.match(component, /navigator\.clipboard\.writeText/);
	assert.match(component, /Clipboard access was denied/i);
	assert.match(component, /vm\.modelYaml/);
});

test("YAML download uses the same in-memory recipe", () => {
	assert.match(component, /new Blob\(\[yaml\]/);
	assert.match(component, /URL\.createObjectURL/);
	assert.match(component, /\.yaml/);
	assert.doesNotMatch(component, /localStorage|sessionStorage/);
});
