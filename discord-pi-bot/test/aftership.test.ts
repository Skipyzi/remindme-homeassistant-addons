import assert from "node:assert/strict";
import test from "node:test";
import {
	AfterShipError,
	createTracking,
	getTracking,
	normalizeTracking,
} from "../src/harness/aftership.ts";

/** A minimal Response stand-in for an injected fetch. */
function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

test("normalizeTracking pulls tag, message, location and ETA", () => {
	const status = normalizeTracking({
		slug: "dhl",
		tag: "InTransit",
		subtag: "InTransit_001",
		subtag_message: "Arrived at facility",
		expected_delivery: "2026-07-26",
		checkpoints: [
			{ message: "Picked up", location: "Berlin" },
			{ message: "Arrived at facility", location: "Leipzig" },
		],
	});
	assert.equal(status.tag, "InTransit");
	assert.equal(status.message, "Arrived at facility");
	assert.equal(status.location, "Leipzig");
	assert.equal(status.courierSlug, "dhl");
	assert.equal(status.expectedDelivery, "2026-07-26");
	assert.equal(status.delivered, false);
});

test("an unknown tag falls back to Unknown, Delivered sets delivered", () => {
	assert.equal(normalizeTracking({ tag: "Wat" }).tag, "Unknown");
	assert.equal(normalizeTracking({ tag: "Delivered" }).delivered, true);
});

test("getTracking sends the api key header and returns status", async () => {
	let seenHeader = "";
	const fetchLike = (async (_url: string, init: RequestInit) => {
		seenHeader = (init.headers as Record<string, string>)["aftership-api-key"];
		return jsonResponse(200, {
			meta: { code: 200 },
			data: { tracking: { slug: "dpd", tag: "OutForDelivery" } },
		});
	}) as unknown as typeof fetch;
	const status = await getTracking("KEY123", "dpd", "N1", fetchLike);
	assert.equal(seenHeader, "KEY123");
	assert.equal(status.tag, "OutForDelivery");
});

test("a 401 becomes an invalid_key AfterShipError", async () => {
	const fetchLike = (async () =>
		jsonResponse(401, { meta: { code: 401 } })) as unknown as typeof fetch;
	await assert.rejects(
		() => getTracking("bad", "dhl", "N1", fetchLike),
		(error: unknown) =>
			error instanceof AfterShipError && error.code === "invalid_key",
	);
});

test("createTracking with a slug returns the created status", async () => {
	const fetchLike = (async (url: string, init: RequestInit) => {
		assert.equal(init.method, "POST");
		assert.match(String(url), /\/trackings$/);
		return jsonResponse(201, {
			meta: { code: 201 },
			data: { tracking: { slug: "dhl", tag: "InfoReceived" } },
		});
	}) as unknown as typeof fetch;
	const status = await createTracking("KEY", "N1", "dhl", fetchLike);
	assert.equal(status.tag, "InfoReceived");
});

test("createTracking is idempotent: 4003 already-exists falls back to GET", async () => {
	const calls: string[] = [];
	const fetchLike = (async (url: string, init: RequestInit) => {
		calls.push(`${init.method} ${String(url)}`);
		if (init.method === "POST" && String(url).endsWith("/trackings"))
			return jsonResponse(400, { meta: { code: 4003, message: "exists" } });
		return jsonResponse(200, {
			meta: { code: 200 },
			data: { tracking: { slug: "dhl", tag: "InTransit" } },
		});
	}) as unknown as typeof fetch;
	const status = await createTracking("KEY", "N1", "dhl", fetchLike);
	assert.equal(status.tag, "InTransit");
	assert.ok(calls.some((call) => call.startsWith("GET")));
});
