import type { ParcelTag } from "./parcelStore";

/*
 * A thin TrackingMore v4 client. TrackingMore is a multi-carrier aggregator:
 * you register a tracking number once (POST /trackings/create) and it polls the
 * carrier itself; reads (GET /trackings/get) return its cached status and do
 * not spend the monthly create quota, so refreshing on a cadence is free. Only
 * the fields the parcel tracker needs are surfaced. `fetch` is injectable for
 * tests.
 */
const BASE_URL = "https://api.trackingmore.com/v4";

/** TrackingMore delivery_status → the tracker's tag. */
function toTag(value: unknown): ParcelTag {
	switch (String(value || "").toLowerCase()) {
		case "pending":
			return "Pending";
		case "inforeceived":
		case "info_received":
			return "InfoReceived";
		case "transit":
			return "InTransit";
		case "pickup":
			return "OutForDelivery";
		case "delivered":
			return "Delivered";
		case "undelivered":
			return "AttemptFail";
		case "exception":
			return "Exception";
		case "expired":
			return "Expired";
		default:
			return "Unknown";
	}
}

export interface TrackingStatus {
	tag: ParcelTag;
	message: string;
	location?: string;
	courierSlug: string;
	courierName?: string;
	expectedDelivery?: string;
	delivered: boolean;
	/** TrackingMore's own id for the tracking, needed to delete it server-side. */
	providerId?: string;
}

type FetchLike = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export class TrackingError extends Error {
	code: string;
	status: number;
	constructor(code: string, message: string, status: number) {
		super(message);
		this.name = "TrackingError";
		this.code = code;
		this.status = status;
	}
}

function headers(apiKey: string): Record<string, string> {
	return { "Tracking-Api-Key": apiKey, "Content-Type": "application/json" };
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

function throwError(response: Response, body: Record<string, unknown>): never {
	const meta = body.meta as { code?: number; message?: string } | undefined;
	if (response.status === 401)
		throw new TrackingError(
			"invalid_key",
			"TrackingMore API key is missing or invalid.",
			401,
		);
	throw new TrackingError(
		String(meta?.code || response.status),
		meta?.message || "TrackingMore request failed.",
		response.status,
	);
}

/** The most recent checkpoint TrackingMore holds, if any. */
function latestCheckpoint(
	item: Record<string, unknown>,
): Record<string, unknown> {
	const origin = item.origin_info as
		| { trackinfo?: Array<Record<string, unknown>> }
		| undefined;
	const info = Array.isArray(origin?.trackinfo) ? origin.trackinfo : [];
	// TrackingMore lists checkpoints newest-first.
	return info[0] || {};
}

/** Turn a TrackingMore `data` item into the fields the tracker keeps. */
export function normalizeTracking(
	item: Record<string, unknown>,
): TrackingStatus {
	const tag = toTag(item.delivery_status);
	const checkpoint = latestCheckpoint(item);
	const message =
		(typeof item.latest_event === "string" && item.latest_event) ||
		(typeof checkpoint.tracking_detail === "string" &&
			checkpoint.tracking_detail) ||
		tag;
	const location =
		typeof checkpoint.location === "string" && checkpoint.location
			? checkpoint.location
			: undefined;
	const slug = String(item.courier_code || "");
	const expected =
		(typeof item.scheduled_delivery_date === "string" &&
			item.scheduled_delivery_date) ||
		(typeof item.expected_delivery_date === "string" &&
			item.expected_delivery_date) ||
		"";
	return {
		tag,
		message: String(message),
		location,
		courierSlug: slug,
		courierName: slug || undefined,
		expectedDelivery: expected || undefined,
		delivered: tag === "Delivered",
		providerId: item.id ? String(item.id) : undefined,
	};
}

/** Ask TrackingMore which courier a number belongs to; returns a code or "". */
export async function detectCourier(
	apiKey: string,
	trackingNumber: string,
	fetchLike: FetchLike = fetch,
): Promise<string> {
	const response = await fetchLike(`${BASE_URL}/couriers/detect`, {
		method: "POST",
		headers: headers(apiKey),
		body: JSON.stringify({ tracking_number: trackingNumber }),
	});
	const body = await readBody(response);
	if (!response.ok) return "";
	const data = body.data as Array<{ courier_code?: string }> | undefined;
	return data?.[0]?.courier_code || "";
}

/** Current status of an already-registered tracking. */
export async function getTracking(
	apiKey: string,
	courier: string,
	trackingNumber: string,
	fetchLike: FetchLike = fetch,
): Promise<TrackingStatus> {
	const params = new URLSearchParams({ tracking_numbers: trackingNumber });
	if (courier) params.set("courier_code", courier);
	const response = await fetchLike(`${BASE_URL}/trackings/get?${params}`, {
		method: "GET",
		headers: headers(apiKey),
	});
	const body = await readBody(response);
	if (!response.ok) throwError(response, body);
	const data = body.data as Array<Record<string, unknown>> | undefined;
	if (!data || !data.length)
		throw new TrackingError(
			"no_tracking",
			"TrackingMore has no status for that number yet.",
			404,
		);
	return normalizeTracking(data[0]);
}

/**
 * Register a tracking number and return its current status. A missing courier
 * is auto-detected. If TrackingMore already has the number (code 4016), its
 * status is fetched instead, so adding is idempotent. Because create does not
 * always carry a status yet, the status is always read back with a GET.
 */
export async function createTracking(
	apiKey: string,
	trackingNumber: string,
	courier: string | undefined,
	fetchLike: FetchLike = fetch,
): Promise<TrackingStatus> {
	let code = courier?.trim() || "";
	if (!code) code = await detectCourier(apiKey, trackingNumber, fetchLike);
	if (!code)
		throw new TrackingError(
			"unknown_courier",
			"Could not detect the courier. Pass one explicitly, e.g. dhl, ups, hermes.",
			400,
		);
	const response = await fetchLike(`${BASE_URL}/trackings/create`, {
		method: "POST",
		headers: headers(apiKey),
		body: JSON.stringify({
			tracking_number: trackingNumber,
			courier_code: code,
		}),
	});
	const body = await readBody(response);
	// 4016: already registered — not an error, just read its status.
	if (!response.ok && metaCode(body) !== 4016) throwError(response, body);
	return getTracking(apiKey, code, trackingNumber, fetchLike);
}

/**
 * Delete a tracking from TrackingMore's servers by its provider id, so a
 * delivered or forgotten parcel does not linger there. Best-effort: a missing
 * id or a not-found tracking resolves quietly, since the goal is only that the
 * record is gone.
 */
export async function deleteTracking(
	apiKey: string,
	providerId: string,
	fetchLike: FetchLike = fetch,
): Promise<void> {
	if (!providerId) return;
	const response = await fetchLike(
		`${BASE_URL}/trackings/${encodeURIComponent(providerId)}`,
		{ method: "DELETE", headers: headers(apiKey) },
	);
	// 404/410: already gone — that is the desired end state, not a failure.
	if (!response.ok && response.status !== 404 && response.status !== 410) {
		const body = await readBody(response);
		throwError(response, body);
	}
}
