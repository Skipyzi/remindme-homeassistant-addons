import assert from "node:assert/strict";
import test from "node:test";
import {
	TrackingError,
	createTracking,
	getTracking,
	normalizeTracking,
} from "../src/harness/trackingmore.ts";

/** A minimal Response stand-in for an injected fetch. */
function jsonResponse(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

test("normalizeTracking maps status, message, location and ETA", () => {
	const status = normalizeTracking({
		courier_code: "dhl",
		delivery_status: "transit",
		latest_event: "Arrived at facility",
		scheduled_delivery_date: "2026-07-26",
		origin_info: {
			trackinfo: [
				{ tracking_detail: "Arrived at facility", location: "Leipzig" },
				{ tracking_detail: "Picked up", location: "Berlin" },
			],
		},
	});
	assert.equal(status.tag, "InTransit");
	assert.equal(status.message, "Arrived at facility");
	assert.equal(status.location, "Leipzig");
	assert.equal(status.courierSlug, "dhl");
	assert.equal(status.expectedDelivery, "2026-07-26");
	assert.equal(status.delivered, false);
});

test("status mapping covers pickup, delivered and unknown", () => {
	assert.equal(normalizeTracking({ delivery_status: "pickup" }).tag, "OutForDelivery");
	assert.equal(normalizeTracking({ delivery_status: "delivered" }).delivered, true);
	assert.equal(normalizeTracking({ delivery_status: "wat" }).tag, "Unknown");
});

test("getTracking sends the api key header and returns status", async () => {
	let seenHeader = "";
	const fetchLike = (async (_url: string, init: RequestInit) => {
		seenHeader = (init.headers as Record<string, string>)["Tracking-Api-Key"];
		return jsonResponse(200, {
			meta: { code: 200 },
			data: [{ courier_code: "ups", delivery_status: "pickup" }],
		});
	}) as unknown as typeof fetch;
	const status = await getTracking("KEY123", "ups", "1Z1", fetchLike);
	assert.equal(seenHeader, "KEY123");
	assert.equal(status.tag, "OutForDelivery");
});

test("a 401 becomes an invalid_key TrackingError", async () => {
	const fetchLike = (async () =>
		jsonResponse(401, { meta: { code: 4101 } })) as unknown as typeof fetch;
	await assert.rejects(
		() => getTracking("bad", "dhl", "N1", fetchLike),
		(error: unknown) =>
			error instanceof TrackingError && error.code === "invalid_key",
	);
});

test("createTracking registers then reads back the status", async () => {
	const calls: string[] = [];
	const fetchLike = (async (url: string, init: RequestInit) => {
		calls.push(`${init.method} ${String(url)}`);
		if (String(url).endsWith("/trackings/create"))
			return jsonResponse(200, { meta: { code: 200 }, data: {} });
		return jsonResponse(200, {
			meta: { code: 200 },
			data: [{ courier_code: "dhl", delivery_status: "inforeceived" }],
		});
	}) as unknown as typeof fetch;
	const status = await createTracking("KEY", "N1", "dhl", fetchLike);
	assert.equal(status.tag, "InfoReceived");
	assert.ok(calls.some((call) => call.includes("/trackings/create")));
	assert.ok(calls.some((call) => call.includes("/trackings/get")));
});

test("createTracking is idempotent: 4016 already-exists still reads status", async () => {
	const fetchLike = (async (url: string, init: RequestInit) => {
		if (init.method === "POST" && String(url).endsWith("/trackings/create"))
			return jsonResponse(400, { meta: { code: 4016, message: "exists" } });
		return jsonResponse(200, {
			meta: { code: 200 },
			data: [{ courier_code: "dhl", delivery_status: "transit" }],
		});
	}) as unknown as typeof fetch;
	const status = await createTracking("KEY", "N1", "dhl", fetchLike);
	assert.equal(status.tag, "InTransit");
});
