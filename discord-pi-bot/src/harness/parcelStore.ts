import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/*
 * Parcels the bot tracks for the owner. Each is a carrier tracking number plus
 * the last status TrackingMore reported; a poller refreshes them and notifies on a
 * status change (see the scheduler, wired in a later slice). Persisted to /data
 * so the tracked list survives restarts, atomic-written like the other stores.
 */
export type ParcelTag =
	| "Pending"
	| "InfoReceived"
	| "InTransit"
	| "OutForDelivery"
	| "AttemptFail"
	| "Delivered"
	| "AvailableForPickup"
	| "Exception"
	| "Expired"
	| "Unknown";

export interface Parcel {
	id: string;
	trackingNumber: string;
	/** TrackingMore courier code, e.g. "dhl", "ups", "hermes". */
	slug: string;
	courierName?: string;
	/** A human label, e.g. "Keyboard from Amazon". */
	label: string;
	tag: ParcelTag;
	/** Human summary of the latest checkpoint or subtag. */
	statusMessage: string;
	location?: string;
	expectedDelivery?: string;
	delivered: boolean;
	createdAt: string;
	updatedAt: string;
	lastCheckedAt?: string;
	/** The tag the owner was last notified about, to detect changes. */
	lastNotifiedTag?: ParcelTag;
}

/** The fields an add or update supplies — everything else is derived. */
export type ParcelInput = Partial<
	Pick<
		Parcel,
		| "trackingNumber"
		| "slug"
		| "courierName"
		| "label"
		| "tag"
		| "statusMessage"
		| "location"
		| "expectedDelivery"
		| "delivered"
		| "lastCheckedAt"
		| "lastNotifiedTag"
	>
>;

function isMissing(error: unknown): boolean {
	return (
		Boolean(error) &&
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: string }).code === "ENOENT"
	);
}

export class ParcelStore {
	private parcels: Parcel[] = [];
	private readonly path: string;

	constructor(path = process.env.PARCEL_DATA_PATH || "./data/parcels.json") {
		this.path = path;
	}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.parcels = Array.isArray(parsed) ? (parsed as Parcel[]) : [];
		} catch (error) {
			if (!isMissing(error)) console.error("Failed to load parcels:", error);
			this.parcels = [];
		}
	}

	/** Write via a temp file and rename so a crash cannot truncate the store. */
	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify(this.parcels, null, 2), "utf8");
		await rename(temporary, this.path);
	}

	list(): Parcel[] {
		return this.parcels;
	}

	get(id: string): Parcel | undefined {
		return this.parcels.find((parcel) => parcel.id === id);
	}

	/** Find a parcel by its tracking number, so the same number isn't tracked twice. */
	findByNumber(trackingNumber: string): Parcel | undefined {
		const needle = trackingNumber.trim().toLowerCase();
		return this.parcels.find(
			(parcel) => parcel.trackingNumber.toLowerCase() === needle,
		);
	}

	async add(values: ParcelInput): Promise<Parcel> {
		const now = new Date().toISOString();
		const parcel: Parcel = {
			id: randomUUID(),
			trackingNumber: String(values.trackingNumber || "").trim(),
			slug: String(values.slug || "").trim(),
			courierName: values.courierName,
			label: String(values.label || "").trim() || "Parcel",
			tag: values.tag || "Pending",
			statusMessage: values.statusMessage || "Tracking started.",
			location: values.location,
			expectedDelivery: values.expectedDelivery,
			delivered: values.delivered ?? false,
			createdAt: now,
			updatedAt: now,
			lastCheckedAt: values.lastCheckedAt,
			lastNotifiedTag: values.lastNotifiedTag,
		};
		this.parcels.unshift(parcel);
		await this.persist();
		return parcel;
	}

	async update(id: string, patch: ParcelInput): Promise<Parcel | undefined> {
		const parcel = this.parcels.find((entry) => entry.id === id);
		if (!parcel) return undefined;
		Object.assign(parcel, patch);
		parcel.updatedAt = new Date().toISOString();
		await this.persist();
		return parcel;
	}

	async remove(id: string): Promise<boolean> {
		const before = this.parcels.length;
		this.parcels = this.parcels.filter((entry) => entry.id !== id);
		if (this.parcels.length === before) return false;
		await this.persist();
		return true;
	}
}

/* Plain-language for each status tag, used in notifications and status cards. */
const TAG_LABEL: Record<ParcelTag, string> = {
	Pending: "tracking started",
	InfoReceived: "label created, awaiting pickup",
	InTransit: "in transit",
	OutForDelivery: "out for delivery",
	AttemptFail: "delivery attempt failed",
	Delivered: "delivered",
	AvailableForPickup: "ready for pickup",
	Exception: "exception — check the carrier",
	Expired: "tracking expired",
	Unknown: "status unknown",
};

export function describeParcelTag(tag: ParcelTag): string {
	return TAG_LABEL[tag] || "status unknown";
}

/**
 * The notification text for a status change, or null when nothing changed since
 * the owner was last told. Pure so the poller's notify-or-skip decision is
 * testable without a network. `previousTag` is the tag the owner last saw.
 */
export function parcelNotice(
	label: string,
	previousTag: ParcelTag | undefined,
	newTag: ParcelTag,
	message?: string,
): string | null {
	if (newTag === previousTag) return null;
	const detail =
		message && message.toLowerCase() !== newTag.toLowerCase()
			? ` — ${message}`
			: "";
	return `📦 ${label}: ${describeParcelTag(newTag)}${detail}`;
}
