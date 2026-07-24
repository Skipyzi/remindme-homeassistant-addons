import assert from "node:assert/strict";
import test from "node:test";
import { describeParcelTag, parcelNotice } from "../src/harness/parcelStore.ts";

test("no notice when the tag is unchanged", () => {
	assert.equal(parcelNotice("Keyboard", "InTransit", "InTransit"), null);
});

test("a tag change produces a notice with the plain-language status", () => {
	const notice = parcelNotice("Keyboard", "InTransit", "OutForDelivery");
	assert.ok(notice);
	assert.match(notice, /Keyboard/);
	assert.match(notice, /out for delivery/);
});

test("the first status (no previous tag) notifies", () => {
	const notice = parcelNotice("Parcel", undefined, "Delivered");
	assert.ok(notice);
	assert.match(notice, /delivered/);
});

test("a distinct carrier message is appended, a redundant one is not", () => {
	assert.match(
		parcelNotice("Box", "InTransit", "Exception", "Held at customs") || "",
		/Held at customs/,
	);
	// A message equal to the tag adds nothing beyond the plain-language status.
	assert.doesNotMatch(
		parcelNotice("Box", "InTransit", "Delivered", "Delivered") || "",
		/— Delivered/,
	);
});

test("describeParcelTag covers every tag and falls back for unknown input", () => {
	assert.equal(describeParcelTag("OutForDelivery"), "out for delivery");
	assert.equal(describeParcelTag("Unknown"), "status unknown");
});
