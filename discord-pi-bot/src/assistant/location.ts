import type { Whereabouts } from "./placeReminders";
import { distance } from "./places";

/**
 * Where the user is, for the assistant: Home Assistant's person, which
 * follows their phone through the Companion app. Every turn gets the rough
 * idea (home, one of their zones, or away and how far), never coordinates;
 * the user_location tool gives the address and, when the last report is
 * old, asks the phone for a fresh one first.
 */

/** Home Assistant's idea of where the user is, and when their phone last said so. */
export interface Fix extends Whereabouts {
	/** When the phone last reported (the person entity's last update). */
	at?: string;
}

/** What the tool hands the model. */
export interface Located {
	/** "home", a zone's name, or "away". */
	where: string;
	address?: string;
	metresFromHome?: number;
	accuracy?: number;
	lat?: number;
	lon?: number;
	/** When the phone last reported. */
	at?: string;
	/** Whether that report is recent enough to trust (under STALE_MS old). */
	fresh: boolean;
	/** Whether the phone was asked just now, and answered. */
	askedPhone?: "answered" | "no answer" | "not possible";
}

/** A report older than this is worth refreshing before answering "where am I". */
export const STALE_MS = 10 * 60_000;
const ASK_EVERY_MS = 2 * 60_000;
const WAIT_MS = 20_000;

const UNKNOWN = ["unknown", "unavailable", ""];

/** "home", "Office" or "away": the zone the person's state names. */
export function placeOf(fix: Fix): string | undefined {
	if (UNKNOWN.includes(fix.state)) return undefined;
	if (fix.state === "home") return "home";
	if (fix.state === "not_home") return "away";
	return fix.zones.find((zone) => zone.name.toLowerCase() === fix.state.toLowerCase())?.name || fix.state;
}

/** Metres from home, when both are known. */
export function fromHome(fix: Fix): number | undefined {
	const home = fix.zones.find((zone) => zone.id === "zone.home");
	if (!home || fix.lat === undefined || fix.lon === undefined) return undefined;
	return Math.round(distance(home, { lat: fix.lat, lon: fix.lon }));
}

/** "about 1.5 km", "about 300 m": rough on purpose. */
export function roughly(metres: number): string {
	if (metres < 1_000) return `about ${Math.max(100, Math.round(metres / 100) * 100)} m`;
	return `about ${metres < 10_000 ? (Math.round(metres / 500) / 2).toFixed(1).replace(/\.0$/, "") : Math.round(metres / 1_000)} km`;
}

/** How old a report is, in words: "3 minutes", "11 hours". */
export function age(at: string | undefined, now: Date): string | undefined {
	const ms = at ? now.getTime() - Date.parse(at) : Number.NaN;
	if (!Number.isFinite(ms) || ms < 0) return undefined;
	const minutes = Math.round(ms / 60_000);
	if (minutes < 2) return "just now";
	if (minutes < 90) return `${minutes} minutes ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 36) return `${hours} hours ago`;
	return `${Math.round(hours / 24)} days ago`;
}

/** The line for every turn: where, roughly, and how old that is. No coordinates. */
export function whereLine(fix: Fix, now = new Date()): string | undefined {
	const place = placeOf(fix);
	if (!place) return undefined;
	const metres = fromHome(fix);
	const said = place === "home" ? "at home" : place === "away" ? `away from home${metres !== undefined ? `, ${roughly(metres)} from it` : ""}` : `at ${place}`;
	const old = age(fix.at, now);
	const stale = fix.at ? now.getTime() - Date.parse(fix.at) > STALE_MS : true;
	return `Where the user is, from their phone in Home Assistant: ${said}${old ? ` (reported ${old}${stale ? ", so it may be out of date" : ""})` : ""}. For their address or what's near them, use user_location; never guess a location.`;
}

export class UserLocation {
	private lastAsked = 0;

	constructor(
		private readonly deps: {
			/** Home Assistant's person and zones; undefined when no person is followed. */
			read(): Promise<Fix | undefined>;
			/** Ask the phone for a fresh location; false when there's no phone to ask. */
			askPhone?(): Promise<boolean>;
			/** The street address at a spot. */
			address?(lat: number, lon: number): Promise<string | undefined>;
			now?(): Date;
			waitMs?: number;
			pollMs?: number;
		},
	) {}

	private now(): Date {
		return this.deps.now?.() || new Date();
	}

	/** For each turn's context: quick, rough, and never in the way of answering. */
	async context(): Promise<string | undefined> {
		let timer: NodeJS.Timeout | undefined;
		const slow = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => resolve(undefined), 2_000);
		});
		const fix = await Promise.race([this.deps.read().catch(() => undefined), slow]);
		clearTimeout(timer);
		return fix ? whereLine(fix, this.now()) : undefined;
	}

	/** Where the user is, with the address; asks the phone first when the last report is old. */
	async locate(): Promise<Located | undefined> {
		let fix = await this.deps.read();
		if (!fix) return undefined;
		let askedPhone: Located["askedPhone"];
		const stale = !fix.at || this.now().getTime() - Date.parse(fix.at) > STALE_MS;
		if (stale && this.deps.askPhone && Date.now() - this.lastAsked > ASK_EVERY_MS) {
			this.lastAsked = Date.now();
			const asked = await this.deps.askPhone().catch(() => false);
			askedPhone = asked ? "no answer" : "not possible";
			if (asked) {
				const before = fix.at;
				const until = Date.now() + (this.deps.waitMs ?? WAIT_MS);
				while (Date.now() < until) {
					await new Promise((resolve) => setTimeout(resolve, this.deps.pollMs ?? 2_000));
					const next = await this.deps.read().catch(() => undefined);
					if (next && next.at !== before) {
						fix = next;
						askedPhone = "answered";
						break;
					}
				}
			}
		}
		const where = placeOf(fix);
		if (!where) return { where: "unknown", fresh: false, ...(askedPhone ? { askedPhone } : {}) };
		const address = fix.lat !== undefined && fix.lon !== undefined ? await this.deps.address?.(fix.lat, fix.lon).catch(() => undefined) : undefined;
		const metres = fromHome(fix);
		return {
			where,
			...(address ? { address } : {}),
			...(metres !== undefined ? { metresFromHome: metres } : {}),
			...(fix.accuracy !== undefined ? { accuracy: Math.round(fix.accuracy) } : {}),
			...(fix.lat !== undefined && fix.lon !== undefined ? { lat: Number(fix.lat.toFixed(4)), lon: Number(fix.lon.toFixed(4)) } : {}),
			...(fix.at ? { at: fix.at } : {}),
			fresh: Boolean(fix.at) && this.now().getTime() - Date.parse(fix.at!) <= STALE_MS,
			...(askedPhone ? { askedPhone } : {}),
		};
	}
}
