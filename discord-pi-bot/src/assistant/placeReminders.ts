import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { distance } from "./places";

/**
 * Reminders for arriving at or leaving a place: home, another Home
 * Assistant zone, or a spot found on the map. Home Assistant's person
 * entity says where the user is (from the Companion app on their phone);
 * RemindMe looks every half minute, and a change counts once it has held
 * for a minute, so a phone hovering at a zone's edge doesn't set it off.
 */

export type PlaceEvent = "arrive" | "leave";

export interface PlaceReminder {
	id: string;
	message: string;
	on: PlaceEvent;
	/** "home", "Office", "Rewe Gohlis": what the user calls it. */
	place: string;
	/** A Home Assistant zone, by entity id: the person's state says when they're in it. */
	zone?: string;
	/** A spot from the map: inside is within its radius of the person's position. */
	spot?: { lat: number; lon: number; radius: number };
	/** Fires each time rather than once. */
	everyTime: boolean;
	createdAt: string;
	/** Where they were at the last settled look; unset until the first one. */
	inside?: boolean;
	lastFired?: string;
}

/** What Home Assistant says about the user's whereabouts. */
export interface Whereabouts {
	/** The person's state: "home", "not_home", a zone's name, or "unknown". */
	state: string;
	lat?: number;
	lon?: number;
	/** Metres of GPS uncertainty, when the phone reports it. */
	accuracy?: number;
	zones: Array<{ id: string; name: string; lat: number; lon: number; radius: number }>;
}

const SETTLE_MS = 60_000;
const SPOT_RADIUS = 200;
const MAX_REMINDERS = 50;

/** "when you get home", "when you leave Rewe Gohlis". */
export function placeWhen(reminder: Pick<PlaceReminder, "on" | "place">): string {
	const where = reminder.place === "home" ? "home" : reminder.place;
	return reminder.on === "arrive" ? (where === "home" ? "when you get home" : `when you get to ${where}`) : `when you leave ${where}`;
}

/** Whether the person is at the reminder's place now, or undefined when Home Assistant doesn't know. */
export function isInside(reminder: Pick<PlaceReminder, "zone" | "spot">, where: Whereabouts): boolean | undefined {
	if (["unknown", "unavailable", ""].includes(where.state)) return undefined;
	if (reminder.zone) {
		const zone = where.zones.find((entry) => entry.id === reminder.zone);
		if (!zone) return undefined;
		// The person's state is "home" for zone.home and the zone's name for the others.
		return reminder.zone === "zone.home" ? where.state === "home" : where.state.toLowerCase() === zone.name.toLowerCase();
	}
	if (reminder.spot) {
		if (where.lat === undefined || where.lon === undefined) return undefined;
		const slack = Math.min(where.accuracy ?? 0, 150);
		return distance({ lat: where.lat, lon: where.lon }, reminder.spot) <= reminder.spot.radius + slack;
	}
	return undefined;
}

export class PlaceReminders {
	private reminders: PlaceReminder[] = [];
	/* A change seen but not yet held for a minute: reminder id → what it changed to, and since when. */
	private pending = new Map<string, { inside: boolean; since: number }>();
	private saving = Promise.resolve();
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly deps: {
			/** Where the user is; undefined when no person is set up or Home Assistant is away. */
			where(): Promise<Whereabouts | undefined>;
			/** Deliver it: the same way a reminder that's due goes out. */
			fire(reminder: PlaceReminder): Promise<void>;
			path?: string;
		},
	) {}

	private get path(): string {
		return this.deps.path || process.env.PLACE_REMINDERS_PATH || "./data/place-reminders.json";
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8"));
			this.reminders = Array.isArray(saved) ? saved.filter((entry) => entry && typeof entry.id === "string" && typeof entry.message === "string") : [];
		} catch {
			this.reminders = [];
		}
	}

	list(): PlaceReminder[] {
		return [...this.reminders];
	}

	/**
	 * A new one: `place` is "home", a zone's name, or a spot from the map
	 * (with lat and lon). It starts from where the user is now, so "when I
	 * get home" said at home waits for the next time they arrive.
	 */
	async add(input: { message: string; on: PlaceEvent; place: string; lat?: number; lon?: number; radius?: number; everyTime?: boolean }): Promise<{ reminder: PlaceReminder; insideNow?: boolean }> {
		if (this.reminders.length >= MAX_REMINDERS) throw new Error(`There are already ${MAX_REMINDERS} place reminders; cancel some first.`);
		const where = await this.deps.where();
		if (!where) throw new Error("Home Assistant doesn't know where the user is: no person with a phone is set up for RemindMe.");
		const name = input.place.trim();
		const reminder: PlaceReminder = {
			id: `place_${Date.now()}_${randomUUID().slice(0, 6)}`,
			message: input.message.trim(),
			on: input.on,
			place: name,
			everyTime: Boolean(input.everyTime),
			createdAt: new Date().toISOString(),
		};
		if (Number.isFinite(input.lat) && Number.isFinite(input.lon)) {
			reminder.spot = { lat: input.lat!, lon: input.lon!, radius: Math.min(Math.max(input.radius ?? SPOT_RADIUS, 100), 2_000) };
		} else {
			const wanted = /^(home|zu ?hause|daheim)$/i.test(name) ? "zone.home" : undefined;
			const zone = where.zones.find((entry) => entry.id === wanted || entry.name.toLowerCase() === name.toLowerCase() || entry.id === name);
			if (!zone) {
				const known = where.zones.map((entry) => (entry.id === "zone.home" ? "home" : entry.name)).join(", ");
				throw new Error(`There's no Home Assistant zone called "${name}". Zones: ${known || "none"}. For another place, find it with find_place and pass its lat and lon.`);
			}
			reminder.zone = zone.id;
			if (zone.id === "zone.home") reminder.place = "home";
			else reminder.place = zone.name;
		}
		const insideNow = isInside(reminder, where);
		if (insideNow !== undefined) reminder.inside = insideNow;
		this.reminders.push(reminder);
		this.save();
		return { reminder, insideNow };
	}

	cancel(id: string): boolean {
		const before = this.reminders.length;
		this.reminders = this.reminders.filter((reminder) => reminder.id !== id);
		this.pending.delete(id);
		if (before === this.reminders.length) return false;
		this.save();
		return true;
	}

	/** One look: a change that has held for a minute fires what it should. */
	async check(now = Date.now()): Promise<PlaceReminder[]> {
		if (!this.reminders.length) return [];
		const where = await this.deps.where().catch(() => undefined);
		if (!where) return [];
		const fired: PlaceReminder[] = [];
		let changed = false;
		for (const reminder of [...this.reminders]) {
			const inside = isInside(reminder, where);
			if (inside === undefined) continue;
			if (reminder.inside === undefined) {
				reminder.inside = inside;
				changed = true;
				continue;
			}
			if (inside === reminder.inside) {
				this.pending.delete(reminder.id);
				continue;
			}
			const seen = this.pending.get(reminder.id);
			if (!seen || seen.inside !== inside) {
				this.pending.set(reminder.id, { inside, since: now });
				continue;
			}
			if (now - seen.since < SETTLE_MS) continue;
			this.pending.delete(reminder.id);
			reminder.inside = inside;
			changed = true;
			if ((reminder.on === "arrive") !== inside) continue;
			try {
				await this.deps.fire(reminder);
			} catch (error) {
				console.warn("A place reminder couldn't go out:", error instanceof Error ? error.message : error);
				continue;
			}
			fired.push(reminder);
			reminder.lastFired = new Date(now).toISOString();
			if (!reminder.everyTime) this.reminders = this.reminders.filter((entry) => entry.id !== reminder.id);
		}
		if (changed || fired.length) this.save();
		return fired;
	}

	startClock(everyMs = 30_000): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.check().catch((error) => console.warn("Place reminders:", error instanceof Error ? error.message : error)), everyMs);
		this.timer.unref?.();
	}

	private save(): void {
		const snapshot = JSON.stringify(this.reminders, null, 1);
		const path = this.path;
		this.saving = this.saving
			.then(async () => {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(`${path}.tmp`, snapshot);
				await rename(`${path}.tmp`, path);
			})
			.catch((error) => console.warn("Could not save place reminders:", error instanceof Error ? error.message : error));
	}

	flushed(): Promise<void> {
		return this.saving;
	}
}
