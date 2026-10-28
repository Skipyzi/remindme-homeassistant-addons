import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/* components/cats.js runs in the browser; here it gets a window and nothing else. */
const context = { window: {} };
vm.runInNewContext(readFileSync("public/components/cats.js", "utf8"), context);
const { draw } = context.window.RemindMeCats;

test("every thread keeps its own cat, and the cast covers every coat", () => {
	assert.equal(draw("thread-1", "done"), draw("thread-1", "done"), "the same id draws the same cat");
	const coats = new Set();
	for (let n = 0; n < 200; n++) coats.add(draw(`thread-${n}`, "done").match(/<path d="M9 38[^"]*" fill="(#[0-9a-f]{6})"/)[1]);
	assert.equal(coats.size, 6, `six coats, got ${[...coats].join(" ")}`);
});

test("the cat's mood follows its job", () => {
	const asking = draw("flights", "asking");
	const working = draw("flights", "working");
	const done = draw("flights", "done");
	const stopped = draw("flights", "stopped");
	assert.match(asking, /<circle cx="36" cy="5" r="5" fill="#fff"\/>/, "a cat that needs you holds up a !");
	assert.doesNotMatch(done, /cx="36" cy="5"/);
	assert.match(stopped, /fill="#8a8a8f"/, "a stopped job's cat goes grey");
	assert.notEqual(working, done);
	for (const svg of [asking, working, done, stopped]) {
		assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*aria-hidden="true"/);
		assert.match(svg, /class="rm-cat-tail"/, "the tail can swish");
		assert.doesNotMatch(svg, /<script|on\w+=/i);
	}
	assert.doesNotMatch(readFileSync("public/components/cats.js", "utf8"), /innerHTML/, "drawn through DOMParser, never innerHTML");
});
