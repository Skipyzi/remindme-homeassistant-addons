import type { ParcelTag } from "../harness/parcelStore";
import { TrackingError, type TrackingStatus } from "../harness/trackingmore";

/**
 * DHL's own Shipment Tracking API (the "Unified" one at developer.dhl.com),
 * as a connector: a free key tracks every DHL service (Paket, Express,
 * eCommerce, Post) straight from DHL, without an aggregator in between.
 * The free level allows 250 calls a day and one every 5 seconds, so calls
 * are queued five seconds apart and counted.
 */
export const DHL_KIND = {
	id: "parcel",
	label: "Parcel service",
	description:
		"Tracks parcels straight from the carrier: give RemindMe a tracking number, or ask it to track the parcel from a shipping email, and it tells you when the parcel moves, is out for delivery, waits for pick-up or arrives.",
	presets: [{ id: "dhl", label: "DHL" }],
};

/* DHL_TRACKING_URL: local test runs only, against a stand-in. */
const ENDPOINT = process.env.DHL_TRACKING_URL || "https://api-eu.dhl.com/track/shipments";
/** DHL's free level: 250 a day. Background checks stop short of it, so asking still works. */
export const DHL_DAILY = 250;
export const DHL_BACKGROUND_SHARE = 200;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface DhlShipment {
	id?: string;
	service?: string;
	status?: {
		timestamp?: string;
		statusCode?: "pre-transit" | "transit" | "delivered" | "failure" | "unknown";
		status?: string;
		statusDetailed?: string;
		description?: string;
		remark?: string;
		location?: { address?: { addressLocality?: string } };
	};
	estimatedTimeOfDelivery?: string;
	estimatedDeliveryTimeFrame?: { estimatedFrom?: string; estimatedThrough?: string };
	details?: { product?: { productName?: string } };
}

const READY_FOR_PICKUP = /ready for pick[- ]?up|available for pick[- ]?up|zur abholung|abholbereit|kann .* abgeholt werden/i;
const OUT_FOR_DELIVERY = /out for delivery|loaded onto the delivery vehicle|on (its|the) way to the recipient|zustellfahrzeug|in zustellung|wird heute zugestellt/i;
const ATTEMPT = /attempt|could not be delivered|recipient not (at home|found)|zustellversuch|nicht angetroffen|konnte nicht zugestellt/i;

/** One DHL shipment as the parcel tracker's status. */
export function dhlStatus(shipment: DhlShipment): TrackingStatus {
	const status = shipment.status || {};
	const words = [status.status, status.statusDetailed, status.description, status.remark].filter(Boolean).join(" ");
	const code = status.statusCode;
	let tag: ParcelTag;
	if (code === "delivered") tag = "Delivered";
	else if (code === "failure") tag = ATTEMPT.test(words) ? "AttemptFail" : "Exception";
	else if (READY_FOR_PICKUP.test(words)) tag = "AvailableForPickup";
	else if (OUT_FOR_DELIVERY.test(words)) tag = "OutForDelivery";
	else if (code === "transit") tag = "InTransit";
	else if (code === "pre-transit") tag = "InfoReceived";
	else tag = "Unknown";
	const product = shipment.details?.product?.productName;
	const expected = shipment.estimatedTimeOfDelivery || shipment.estimatedDeliveryTimeFrame?.estimatedFrom;
	const location = status.location?.address?.addressLocality;
	return {
		tag,
		message: (status.description || status.status || "No details from DHL yet").replace(/\s+/g, " ").trim().slice(0, 300),
		...(location ? { location } : {}),
		courierSlug: "dhl",
		courierName: product && !/^dhl\b/i.test(product) ? `DHL ${product}` : product || "DHL",
		...(expected ? { expectedDelivery: expected } : {}),
		delivered: code === "delivered",
	};
}

/**
 * Numbers DHL uses: Paket (12 or 20 digits, the long ones starting 00340),
 * Express (10 digits), eCommerce and Express (JJD…, JVGL…, GM…), and
 * international post (two letters, nine digits, DE). A hint only: DHL is
 * asked anyway when no other carrier can be.
 */
export function looksLikeDhl(number: string): boolean {
	const plain = number.replace(/\s+/g, "").toUpperCase();
	return /^(\d{12}|\d{10}|00340\d{15}|\d{20}|JJD\d{8,}|JVGL\d{6,}|GM\d{10,}|[A-Z]{2}\d{9}DE|3S[A-Z0-9]{8,})$/.test(plain);
}

/** Which tracker a new number goes to: DHL itself, TrackingMore, or neither (with why). */
export function chooseTracker(number: string, courier: string, have: { dhl: boolean; trackingMore: boolean }): "dhl" | "trackingmore" | { error: string } {
	const named = courier.trim().toLowerCase();
	if (!have.dhl && !have.trackingMore) return { error: "Parcel tracking is off. Add DHL under Settings → Connectors → Parcels, or a TrackingMore key in the app's options for other carriers." };
	if (named && !named.startsWith("dhl")) return have.trackingMore ? "trackingmore" : { error: `Only DHL is connected, and this is ${courier}. Other carriers need a TrackingMore key in the app's options.` };
	if (have.dhl && (named.startsWith("dhl") || looksLikeDhl(number) || !have.trackingMore)) return "dhl";
	return "trackingmore";
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class DhlTracker {
	private chain: Promise<unknown> = Promise.resolve();
	private lastCall = 0;
	private used = { day: "", calls: 0 };
	private lastStatus?: { ok: boolean; at: string; error?: string };

	constructor(
		private readonly settings: { key(): string | undefined; postcode?(): string | undefined },
		private readonly options: { fetch?: FetchLike; spacingMs?: number; language?: string } = {},
	) {}

	/** Calls today (UTC, as DHL counts), and the last answer. */
	status(now = new Date()): { ok: boolean; at: string; error?: string; calls: number; limit: number } | undefined {
		const calls = this.used.day === now.toISOString().slice(0, 10) ? this.used.calls : 0;
		return this.lastStatus ? { ...this.lastStatus, calls, limit: DHL_DAILY } : undefined;
	}

	callsToday(now = new Date()): number {
		return this.used.day === now.toISOString().slice(0, 10) ? this.used.calls : 0;
	}

	/** One call at a time, five seconds apart, as DHL's free level asks. */
	private queued<T>(work: () => Promise<T>): Promise<T> {
		const run = this.chain.then(async () => {
			const wait = this.lastCall + (this.options.spacingMs ?? 5_100) - Date.now();
			if (wait > 0) await pause(wait);
			this.lastCall = Date.now();
			return work();
		});
		this.chain = run.catch(() => undefined);
		return run;
	}

	private async call(number: string, key: string): Promise<Response> {
		const url = new URL(ENDPOINT);
		url.searchParams.set("trackingNumber", number);
		url.searchParams.set("language", this.options.language || "en");
		const postcode = this.settings.postcode?.()?.trim();
		if (postcode) url.searchParams.set("recipientPostalCode", postcode);
		const today = new Date().toISOString().slice(0, 10);
		if (this.used.day !== today) this.used = { day: today, calls: 0 };
		this.used.calls++;
		return (this.options.fetch || fetch)(url, { headers: { "DHL-API-Key": key, Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
	}

	/** Where a parcel is now. Throws a TrackingError the user can act on. */
	async track(number: string, key = this.settings.key()): Promise<TrackingStatus> {
		if (!key) throw new TrackingError("dhl_off", "DHL isn't connected. Add it under Settings → Connectors → Parcels.", 0);
		const plain = number.replace(/\s+/g, "");
		return this.queued(async () => {
			const at = new Date().toISOString();
			try {
				const response = await this.call(plain, key);
				const body = (await response.json().catch(() => ({}))) as { shipments?: DhlShipment[]; detail?: string; title?: string };
				if (response.status === 401 || response.status === 403) throw new TrackingError("dhl_key", "DHL didn't accept the API key. Check it under Settings → Connectors → Parcels.", response.status);
				if (response.status === 429) throw new TrackingError("dhl_limit", `DHL's limit of ${DHL_DAILY} checks a day is used up. It resets at midnight (UTC).`, 429);
				if (response.status === 404) {
					this.lastStatus = { ok: true, at };
					throw new TrackingError("dhl_unknown", "DHL doesn't know that number (yet). New labels can take a day to show up.", 404);
				}
				if (!response.ok) throw new TrackingError("dhl_error", `DHL answered with ${response.status}${body.detail ? `: ${body.detail}` : ""}.`, response.status);
				const shipment = body.shipments?.[0];
				if (!shipment) throw new TrackingError("dhl_unknown", "DHL doesn't know that number (yet).", 404);
				this.lastStatus = { ok: true, at };
				return dhlStatus(shipment);
			} catch (error) {
				if (!(error instanceof TrackingError && error.status === 404)) this.lastStatus = { ok: false, at, error: error instanceof Error ? error.message : String(error) };
				throw error;
			}
		});
	}

	/** Whether DHL takes a key: a made-up number answers "not found" with a good key, and "unauthorized" without. */
	async test(key = this.settings.key()): Promise<string> {
		try {
			await this.track("00340434000000000000", key);
			return "DHL accepted the key.";
		} catch (error) {
			if (error instanceof TrackingError && error.status === 404) return "DHL accepted the key.";
			throw error;
		}
	}
}
