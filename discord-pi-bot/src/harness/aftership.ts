import type { ParcelTag } from "./parcelStore";

/*
 * A thin AfterShip v4 client. AfterShip is an aggregator: you register a
 * tracking number once (POST /trackings), and it polls the carrier itself;
 * reads (GET) return its cached status and do not consume the monthly shipment
 * quota, so refreshing on a cadence is free. Only the fields the tracker needs
 * are surfaced. `fetch` is injectable for tests.
 */
const BASE_URL = "https://api.aftership.com/v4";

const KNOWN_TAGS: ParcelTag[] = [
	"Pending",
	"InfoReceived",
	"InTransit",
	"OutForDelivery",
	"AttemptFail",
	"Delivered",
	"AvailableForPickup",
	"Exception",
	"Expired",
];

export interface AfterShipStatus {
	tag: ParcelTag;
	subtag?: string;
	message: string;
	location?: string;
	courierSlug: string;
	courierName?: string;
	expectedDelivery?: string;
	delivered: boolean;
}

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export class AfterShipError extends Error {
	code: string;
	status: number;
	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "AfterShipError";
		this.code = code;
		this.status = status;
	}
}

function headers(apiKey: string): Record<string, string> {
	return { "aftership-api-key": apiKey, "Content-Type": "application/json" };
}

function toTag(value: unknown): ParcelTag {
	return KNOWN_TAGS.includes(value as ParcelTag) ? (value as ParcelTag) : "Unknown";
}

/** Turn AfterShip's `data.tracking` object into the fields the tracker keeps. */
export function normalizeTracking(tracking: Record<string, unknown>): AfterShipStatus {
	const tag = toTag(tracking.tag);
	const checkpoints = Array.isArray(tracking.checkpoints)
		? (tracking.checkpoints as Array<Record<string, unknown>>)
		: [];
	const latest = checkpoints[checkpoints.length - 1] || {};
	const message =
		(typeof tracking.subtag_message === "string" && tracking.subtag_message) ||
		(typeof latest.message === "string" && latest.message) ||
		tag;
	const location =
		(typeof latest.location === "string" && latest.location) ||
		(typeof latest.city === "string" && latest.city) ||
		undefined;
	const slug = String(tracking.slug || "");
	return {
		tag,
		subtag: typeof tracking.subtag === "string" ? tracking.subtag : undefined,
		message: String(message),
		location: location || undefined,
		courierSlug: slug,
		courierName: slug || undefined,
		expectedDelivery:
			typeof tracking.expected_delivery === "string" && tracking.expected_delivery
				? tracking.expected_delivery
				: undefined,
		delivered: tag === "Delivered",
	};
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function metaCode(body: Record<string, unknown>): number {
	const meta = body.meta as { code?: number } | undefined;
	return typeof meta?.code === "number" ? meta.code : 0;
}

function trackingFrom(body: Record<string, unknown>): Record<string, unknown> | null {
	const data = body.data as { tracking?: Record<string, unknown> } | undefined;
	return data?.tracking || null;
}

function throwError(response: Response, body: Record<string, unknown>): never {
	const meta = body.meta as { code?: number; message?: string } | undefined;
	if (response.status === 401)
		throw new AfterShipError(
			"invalid_key",
			"AfterShip API key is missing or invalid.",
			401,
		);
	throw new AfterShipError(
		String(meta?.code || response.status),
		meta?.message || "AfterShip request failed.",
		response.status,
	);
}

/** Ask AfterShip which courier a number belongs to; returns a slug or "". */
export async function detectCourier(
	apiKey: string,
	trackingNumber: string,
	fetchLike: FetchLike = fetch,
): Promise<string> {
	const response = await fetchLike(`${BASE_URL}/couriers/detect`, {
		method: "POST",
		headers: headers(apiKey),
		body: JSON.stringify({ tracking: { tracking_number: trackingNumber } }),
	});
	const body = await readBody(response);
	if (!response.ok) return "";
	const data = body.data as { couriers?: Array<{ slug?: string }> } | undefined;
	return data?.couriers?.[0]?.slug || "";
}

/** Current status of an already-registered tracking. */
export async function getTracking(
	apiKey: string,
	slug: string,
	trackingNumber: string,
	fetchLike: FetchLike = fetch,
): Promise<AfterShipStatus> {
	const response = await fetchLike(
		`${BASE_URL}/trackings/${encodeURIComponent(slug)}/${encodeURIComponent(trackingNumber)}`,
		{ method: "GET", headers: headers(apiKey) },
	);
	const body = await readBody(response);
	if (!response.ok) throwError(response, body);
	const tracking = trackingFrom(body);
	if (!tracking)
		throw new AfterShipError("no_tracking", "AfterShip returned no tracking.", 502);
	return normalizeTracking(tracking);
}

/**
 * Register a tracking number and return its first status. A missing slug is
 * auto-detected. If AfterShip already has the number (code 4003), its current
 * status is fetched instead so adding is idempotent.
 */
export async function createTracking(
	apiKey: string,
	trackingNumber: string,
	slug: string | undefined,
	fetchLike: FetchLike = fetch,
): Promise<AfterShipStatus> {
	let courier = slug?.trim() || "";
	if (!courier) courier = await detectCourier(apiKey, trackingNumber, fetchLike);
	const tracking: Record<string, string> = { tracking_number: trackingNumber };
	if (courier) tracking.slug = courier;
	const response = await fetchLike(`${BASE_URL}/trackings`, {
		method: "POST",
		headers: headers(apiKey),
		body: JSON.stringify({ tracking }),
	});
	const body = await readBody(response);
	if (response.ok) {
		const created = trackingFrom(body);
		if (!created)
			throw new AfterShipError("no_tracking", "AfterShip returned no tracking.", 502);
		return normalizeTracking(created);
	}
	// 4003: already registered — read its current status instead of failing.
	if (metaCode(body) === 4003 && courier)
		return getTracking(apiKey, courier, trackingNumber, fetchLike);
	throwError(response, body);
}
