import assert from "node:assert/strict";
import test from "node:test";
import { DhlTracker, chooseTracker, dhlStatus, looksLikeDhl } from "../src/connectors/dhl.ts";
import { TrackingError } from "../src/harness/trackingmore.ts";

test("DHL's statuses become the tracker's: the spec's own example, and Paket's wording", () => {
	// The example in DHL's OpenAPI description (track v1.5.8).
	assert.deepEqual(
		dhlStatus({
			id: "GMDBD8E9CCE94842E495B7",
			service: "ecommerce",
			status: { timestamp: "2023-01-29T16:02:00", location: { address: { addressLocality: "HEATHROW, GB" } }, statusCode: "transit", status: "ARRIVED AT CUSTOMS" },
			details: { product: { productName: "DHL Parcel Intl Standard" } },
		}),
		{ tag: "InTransit", message: "ARRIVED AT CUSTOMS", location: "HEATHROW, GB", courierSlug: "dhl", courierName: "DHL Parcel Intl Standard", delivered: false },
	);
	const tag = (statusCode: "pre-transit" | "transit" | "delivered" | "failure" | "unknown", description: string) => dhlStatus({ status: { statusCode, description } }).tag;
	assert.equal(tag("pre-transit", "The instruction data for this shipment have been provided by the sender to DHL electronically"), "InfoReceived");
	assert.equal(tag("transit", "The shipment has been processed in the parcel center"), "InTransit");
	assert.equal(tag("transit", "The shipment has been loaded onto the delivery vehicle"), "OutForDelivery");
	assert.equal(tag("transit", "Die Sendung wurde in das Zustellfahrzeug geladen."), "OutForDelivery");
	assert.equal(tag("transit", "The shipment is ready for pick-up at the PACKSTATION 123 in Leipzig"), "AvailableForPickup");
	assert.equal(tag("transit", "Die Sendung liegt in der Filiale zur Abholung bereit."), "AvailableForPickup");
	assert.equal(tag("delivered", "The shipment has been successfully delivered"), "Delivered");
	assert.equal(tag("failure", "An attempt to deliver the shipment was made but the recipient was not at home"), "AttemptFail");
	assert.equal(tag("failure", "The shipment could not be delivered, and the recipient has been notified"), "AttemptFail");
	assert.equal(tag("failure", "The shipment has been damaged"), "Exception");
	assert.equal(tag("unknown", ""), "Unknown");
	const expected = dhlStatus({ status: { statusCode: "transit" }, estimatedDeliveryTimeFrame: { estimatedFrom: "2026-10-30T10:00:00+01:00", estimatedThrough: "2026-10-30T14:00:00+01:00" } });
	assert.equal(expected.expectedDelivery, "2026-10-30T10:00:00+01:00");
	assert.equal(expected.message, "No details from DHL yet");
	assert.equal(expected.courierName, "DHL");
	assert.equal(dhlStatus({ status: { statusCode: "delivered" }, details: { product: { productName: "DHL PAKET" } } }).courierName, "DHL PAKET");
});

test("DHL's numbers are recognised, as a hint", () => {
	for (const number of ["340434161094", "00340434161094042557", "JJD000390007712345678", "1234567890", "RR123456789DE", "GM2951234567890123"]) assert.equal(looksLikeDhl(number), true, number);
	for (const number of ["1Z999AA10123456784", "H1234567890123456789X", "abc"]) assert.equal(looksLikeDhl(number), false, number);
});

test("a new number goes to DHL itself when it can, TrackingMore for other carriers", () => {
	const both = { dhl: true, trackingMore: true };
	assert.equal(chooseTracker("340434161094", "", both), "dhl");
	assert.equal(chooseTracker("H1234567890123456789X", "", both), "trackingmore", "not a DHL number");
	assert.equal(chooseTracker("H1234567890123456789X", "hermes", both), "trackingmore");
	assert.equal(chooseTracker("H1234567890123456789X", "DHL Express", both), "dhl", "the user said DHL");
	assert.equal(chooseTracker("H1234567890123456789X", "", { dhl: true, trackingMore: false }), "dhl", "the only tracker there is");
	assert.deepEqual(chooseTracker("123", "hermes", { dhl: true, trackingMore: false }), { error: "Only DHL is connected, and this is hermes. Other carriers need a TrackingMore key in the app's options." });
	assert.equal(chooseTracker("340434161094", "", { dhl: false, trackingMore: true }), "trackingmore");
	assert.match((chooseTracker("340434161094", "", { dhl: false, trackingMore: false }) as { error: string }).error, /Parcel tracking is off/);
});

function fakeDhl(answers: Array<{ status: number; body?: unknown }>) {
	const calls: Array<{ url: URL; key: string; at: number }> = [];
	const fetch = async (input: string | URL, init?: RequestInit) => {
		calls.push({ url: new URL(String(input)), key: String((init?.headers as Record<string, string>)["DHL-API-Key"]), at: Date.now() });
		const answer = answers.shift() || { status: 500 };
		return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status, headers: { "Content-Type": "application/json" } });
	};
	return { calls, fetch };
}

test("a parcel is asked about with the key, in English, with the postcode; answers and refusals are told plainly", async () => {
	const { calls, fetch } = fakeDhl([
		{ status: 200, body: { shipments: [{ id: "340434161094", status: { statusCode: "transit", description: "The shipment has been loaded onto the delivery vehicle", location: { address: { addressLocality: "Leipzig" } } } }] } },
		{ status: 404, body: { title: "No shipment with given tracking number found." } },
		{ status: 401, body: { title: "Unauthorized" } },
		{ status: 429, body: { title: "Too many requests" } },
	]);
	const tracker = new DhlTracker({ key: () => "key-123", postcode: () => "04109" }, { fetch, spacingMs: 0 });
	const status = await tracker.track("3404 3416 1094");
	assert.equal(status.tag, "OutForDelivery");
	assert.equal(status.location, "Leipzig");
	assert.equal(calls[0].key, "key-123");
	assert.equal(calls[0].url.origin + calls[0].url.pathname, "https://api-eu.dhl.com/track/shipments");
	assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { trackingNumber: "340434161094", language: "en", recipientPostalCode: "04109" });
	await assert.rejects(() => tracker.track("000"), (error: unknown) => error instanceof TrackingError && error.status === 404 && /doesn't know that number/.test(error.message));
	await assert.rejects(() => tracker.track("000"), /didn't accept the API key/);
	await assert.rejects(() => tracker.track("000"), /250 checks a day is used up/);
	assert.equal(tracker.callsToday(), 4);
	assert.equal(tracker.status()?.ok, false);
	await assert.rejects(() => new DhlTracker({ key: () => undefined }).track("1"), /DHL isn't connected/);
});

test("a key is tried with a made-up number: not found means it works", async () => {
	const good = fakeDhl([{ status: 404 }]);
	assert.equal(await new DhlTracker({ key: () => "k" }, { fetch: good.fetch, spacingMs: 0 }).test("new-key-1"), "DHL accepted the key.");
	assert.equal(good.calls[0].key, "new-key-1");
	const bad = fakeDhl([{ status: 401 }]);
	await assert.rejects(() => new DhlTracker({ key: () => "k" }, { fetch: bad.fetch, spacingMs: 0 }).test("wrong-key"), /didn't accept the API key/);
});

test("calls wait their turn, spaced as DHL's free level asks", async () => {
	const { calls, fetch } = fakeDhl([{ status: 404 }, { status: 404 }, { status: 404 }]);
	const tracker = new DhlTracker({ key: () => "k" }, { fetch, spacingMs: 60 });
	await Promise.allSettled([tracker.track("1"), tracker.track("2"), tracker.track("3")]);
	assert.equal(calls.length, 3);
	assert.ok(calls[1].at - calls[0].at >= 55, `${calls[1].at - calls[0].at} ms`);
	assert.ok(calls[2].at - calls[1].at >= 55, `${calls[2].at - calls[1].at} ms`);
	assert.deepEqual(calls.map((call) => call.url.searchParams.get("trackingNumber")), ["1", "2", "3"], "in order");
});
