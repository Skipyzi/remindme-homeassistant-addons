import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HomeApi } from "../agent/home";

/* Home Assistant's CalendarEntityFeature.CREATE_EVENT. */
const CREATE_EVENT = 1;

export interface CalendarInfo {
	entityId: string;
	name: string;
	/** The calendar takes new events (iCloud through CalDAV, a local calendar). */
	writable: boolean;
}

/**
 * Calendars come from Home Assistant: iCloud joins through its CalDAV
 * integration, so an event added here shows in both places.
 */
export async function listCalendars(home: Pick<HomeApi, "cards">): Promise<CalendarInfo[]> {
	return (await home.cards())
		.filter((card) => card.domain === "calendar")
		.map((card) => ({ entityId: card.entityId, name: card.name, writable: (Number(card.attributes.supported_features) & CREATE_EVENT) === CREATE_EVENT }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Which calendar new events go to, chosen in the console. */
export class CalendarChoice {
	private chosen: string | undefined;

	constructor(private readonly path = process.env.CALENDAR_DATA_PATH || "./data/calendar.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as { newEvents?: unknown };
			this.chosen = typeof saved.newEvents === "string" && saved.newEvents ? saved.newEvents : undefined;
		} catch {
			this.chosen = undefined;
		}
	}

	newEvents(): string | undefined {
		return this.chosen;
	}

	async choose(entityId: string | undefined): Promise<void> {
		this.chosen = entityId || undefined;
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(`${this.path}.tmp`, JSON.stringify({ newEvents: this.chosen ?? null }));
		await rename(`${this.path}.tmp`, this.path);
	}
}

export interface EventTimes {
	/** What Home Assistant's calendar.create_event takes. */
	data: { start_date_time: string; end_date_time: string } | { start_date: string; end_date: string };
	/** "Thu 30 Oct, 10:00–11:00". */
	label: string;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const AT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2})?$/;
const CLOCK = /^(\d{2}):(\d{2})$/;
const MAX_DAYS = 14;

/* Wall-clock arithmetic in UTC, so the Pi's own time zone never shifts a time. */
function wall(year: string, month: string, day: string, hour = "00", minute = "00"): Date {
	const at = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)));
	if (at.getUTCMonth() !== Number(month) - 1 || at.getUTCDate() !== Number(day) || Number(hour) > 23 || Number(minute) > 59) throw new Error("That isn't a real date or time.");
	return at;
}
const pad = (value: number) => String(value).padStart(2, "0");
const dayOf = (at: Date) => `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
const clockOf = (at: Date) => `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
const readable = (at: Date) => at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

/**
 * A start and an optional end, in the user's local time, as the event Home
 * Assistant creates. A date alone is an all-day event; a time without an end
 * lasts an hour.
 */
export function eventTimes(start: string, end = ""): EventTimes {
	const startDay = DAY.exec(start.trim());
	if (startDay) {
		const first = wall(startDay[1], startDay[2], startDay[3]);
		const endDay = end.trim() ? DAY.exec(end.trim()) : startDay;
		if (!endDay) throw new Error("An all-day event ends on a date, YYYY-MM-DD.");
		const last = wall(endDay[1], endDay[2], endDay[3]);
		const days = (last.getTime() - first.getTime()) / 86_400_000;
		if (days < 0) throw new Error("The end is before the start.");
		if (days >= MAX_DAYS) throw new Error(`Keep an event under ${MAX_DAYS} days.`);
		// Home Assistant's end date is the day after the last one.
		return {
			data: { start_date: dayOf(first), end_date: dayOf(new Date(last.getTime() + 86_400_000)) },
			label: days ? `${readable(first)} to ${readable(last)}, all day` : `${readable(first)}, all day`,
		};
	}
	const startAt = AT.exec(start.trim());
	if (!startAt) throw new Error("Give the start as YYYY-MM-DDTHH:MM, or a date alone for all day.");
	const from = wall(startAt[1], startAt[2], startAt[3], startAt[4], startAt[5]);
	let to: Date;
	const endAt = AT.exec(end.trim());
	const endClock = CLOCK.exec(end.trim());
	if (endAt) to = wall(endAt[1], endAt[2], endAt[3], endAt[4], endAt[5]);
	else if (endClock) to = wall(startAt[1], startAt[2], startAt[3], endClock[1], endClock[2]);
	else if (!end.trim()) to = new Date(from.getTime() + 3_600_000);
	else throw new Error("Give the end as YYYY-MM-DDTHH:MM or HH:MM.");
	if (to <= from) throw new Error("The end is before the start.");
	if (to.getTime() - from.getTime() > MAX_DAYS * 86_400_000) throw new Error(`Keep an event under ${MAX_DAYS} days.`);
	const sameDay = dayOf(from) === dayOf(to);
	return {
		data: { start_date_time: `${dayOf(from)} ${clockOf(from)}:00`, end_date_time: `${dayOf(to)} ${clockOf(to)}:00` },
		label: sameDay ? `${readable(from)}, ${clockOf(from)}–${clockOf(to)}` : `${readable(from)} ${clockOf(from)} to ${readable(to)} ${clockOf(to)}`,
	};
}
