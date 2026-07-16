import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("public/app.js", "utf8");

test("settings save displays the server error instead of failing silently", () => {
	assert.match(app, /await r\.json\(\)\.catch/);
	assert.match(app, /payload\.error/);
	assert.match(app, /Save failed:/);
});
