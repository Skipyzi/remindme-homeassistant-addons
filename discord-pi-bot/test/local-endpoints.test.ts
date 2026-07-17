import assert from "node:assert/strict";
import test from "node:test";
import { canonicalLocalEndpoint } from "../src/harness/localEndpoints.ts";

const inference = "http://homeassistant:8080/v1/chat/completions";
const manager = "http://homeassistant:8080/manager/v1";

test("canonicalizes legacy loopback endpoints during migration", () => {
	assert.equal(canonicalLocalEndpoint(inference, "inference", true), inference);
	assert.equal(canonicalLocalEndpoint(manager, "manager", true), manager);
	for (const host of ["localhost", "127.0.0.1"]) {
		assert.equal(
			canonicalLocalEndpoint(
				`http://${host}:8080/v1/chat/completions`,
				"inference",
				true,
			),
			inference,
		);
		assert.equal(
			canonicalLocalEndpoint(
				`http://${host}:8080/manager/v1`,
				"manager",
				true,
			),
			manager,
		);
	}
});

test("strict mode accepts only canonical internal endpoints", () => {
	assert.equal(canonicalLocalEndpoint(inference, "inference"), inference);
	assert.equal(canonicalLocalEndpoint(manager, "manager"), manager);
	assert.throws(() =>
		canonicalLocalEndpoint("http://127.0.0.1:8080/manager/v1", "manager"),
	);
});

test("rejects unsafe or malformed local endpoints", () => {
	for (const value of [
		"https://homeassistant:8080/manager/v1",
		"http://example.test:8080/manager/v1",
		"http://homeassistant:8090/manager/v1",
		"http://user:pass@homeassistant:8080/manager/v1",
		"http://homeassistant:8080/manager/v1?token=x",
		"http://homeassistant:8080/manager/v1#fragment",
		"http://homeassistant:8080/v1/chat/completions",
	]) {
		assert.throws(() => canonicalLocalEndpoint(value, "manager", true), value);
	}
});
