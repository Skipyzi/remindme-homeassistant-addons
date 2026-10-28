import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EntityCard } from "../harness/entities";

/** How a battery is kept going, from the device's other entities in Home Assistant. */
export interface BatteryKind {
	/** It has a charging or battery-state entity: it gets charged, not swapped. */
	rechargeable: boolean;
	/** A phone or computer with the Companion app: it warns about its own battery. */
	companion: boolean;
	/** The entities that say whether it is charging right now. */
	chargers: string[];
}

export interface LowBattery {
	entityId: string;
	/** The device, without "battery" or "Battery Level". */
	name: string;
	level: number;
	rechargeable: boolean;
	/** What to buy when the device says: "CR2032", "2 × AAA". */
	battery?: string;
}

/* Without the device registry (older Home Assistant), names give rechargeables away. */
const RECHARGEABLE_NAME = /\b(i?phone|ipad|pixel|galaxy|tablet|watch|macbook|laptop|airpods|headphones|kopfhörer|toothbrush|zahnbürste|vacuum|sauger)\b/i;
const CHARGING_STATES = new Set(["on", "charging", "full"]);

export const deviceName = (card: Pick<EntityCard, "name">) => card.name.replace(/\s*battery(\s*level)?$/i, "").trim() || card.name;

/** "CR2032", or "2 × AAA" when it takes more than one, from Zigbee's battery_size and battery_quantity. */
export function batteryType(card: Pick<EntityCard, "attributes">): string | undefined {
	const size = typeof card.attributes.battery_size === "string" ? card.attributes.battery_size.trim() : "";
	if (!size || /unknown|other|no battery|built.?in|rechargeable/i.test(size)) return undefined;
	const quantity = Number(card.attributes.battery_quantity);
	return quantity > 1 ? `${quantity} × ${size}` : size;
}

type Need = Pick<LowBattery, "rechargeable" | "battery">;
/** What the card or nudge says to do about it. */
export const batteryHint = (battery: Need) => (battery.rechargeable ? "Needs charging." : battery.battery ? `Needs a new ${battery.battery}.` : "Time for a new battery.");
/** The same in a list: "charge it", "new CR2032". */
export const batteryShort = (battery: Need) => (battery.rechargeable ? "charge it" : `new ${battery.battery || "battery"}`);

/**
 * Batteries at or under the threshold that need the user. One that is
 * charging doesn't, and neither does a phone with the Companion app: it
 * warns about itself, and its battery runs down every day.
 */
export function lowBatteries(cards: EntityCard[], kinds: Map<string, BatteryKind>, threshold: number): LowBattery[] {
	const byId = new Map(cards.map((card) => [card.entityId, card]));
	const out: LowBattery[] = [];
	for (const card of cards) {
		if (!card.available || card.deviceClass !== "battery" || card.numericState === undefined || card.numericState > threshold) continue;
		const kind = kinds.get(card.entityId);
		if (kind?.companion) continue;
		const rechargeable = Boolean(kind?.rechargeable) || RECHARGEABLE_NAME.test(card.name);
		if (rechargeable && kind?.chargers.some((id) => CHARGING_STATES.has(String(byId.get(id)?.state || "").toLowerCase()))) continue;
		const battery = rechargeable ? undefined : batteryType(card);
		out.push({ entityId: card.entityId, name: deviceName(card), level: Math.round(card.numericState), rechargeable, ...(battery ? { battery } : {}) });
	}
	return out;
}

interface Hidden {
	/** Back on this date if still low; without one, only once it was charged or replaced. */
	until?: string;
	at: string;
}

/**
 * Batteries the user has dealt with for now: a reminder is set, or they said
 * "Got it". Each comes back when its reminder is due and it's still low, and
 * is forgotten once the battery is above the threshold again.
 */
export class BatteryHides {
	private hidden: Record<string, Hidden> = {};

	constructor(private readonly path = process.env.BATTERY_DATA_PATH || "./data/batteries.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Record<string, Hidden>;
			this.hidden = saved && typeof saved === "object" ? saved : {};
		} catch {
			this.hidden = {};
		}
	}

	private async save(): Promise<void> {
		try {
			await mkdir(dirname(this.path), { recursive: true });
			await writeFile(`${this.path}.tmp`, JSON.stringify(this.hidden));
			await rename(`${this.path}.tmp`, this.path);
		} catch (error) {
			console.warn("Could not save the hidden batteries:", error instanceof Error ? error.message : error);
		}
	}

	async hide(entityId: string, until?: Date, now = new Date()): Promise<void> {
		this.hidden[entityId] = { at: now.toISOString(), ...(until ? { until: until.toISOString() } : {}) };
		await this.save();
	}

	/** The low batteries still to show, forgetting hides that are over. */
	async visible(low: LowBattery[], cards: EntityCard[], threshold: number, now = new Date()): Promise<LowBattery[]> {
		const levels = new Map(cards.map((card) => [card.entityId, card.numericState]));
		let changed = false;
		for (const [entityId, hidden] of Object.entries(this.hidden)) {
			// Only a reading above the threshold counts: Home Assistant being away isn't a new battery.
			const level = levels.get(entityId);
			const recovered = level !== undefined && level > threshold;
			const due = hidden.until !== undefined && Date.parse(hidden.until) <= now.getTime();
			if (recovered || due) {
				delete this.hidden[entityId];
				changed = true;
			}
		}
		if (changed) await this.save();
		return low.filter((battery) => !this.hidden[battery.entityId]);
	}
}
