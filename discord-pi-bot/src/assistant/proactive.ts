import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { localDate } from "../ai/spend";
import type { CalendarEvent, HomeApi } from "../agent/home";
import { stateText } from "../agent/home";
import type { MailWatch } from "../mail/watch";
import type { Assistant } from "./agent";

export interface ProactiveOptions {
	/** "07:00"; blank turns the brief off. */
	briefTime: string;
	/** When to say the bins go out, the evening before collection. Blank turns it off. */
	binTime: string;
	/** "22:30-07:00": no nudges in this window; they wait until it ends. */
	quietHours: string;
	/** Nudge about batteries at or below this percentage. 0 turns it off. */
	batteryThreshold: number;
	/**
	 * The to-do list ("todo.chores") that gets "Put the paper bin out" on the
	 * morning before a collection. Blank turns the chore off.
	 */
	choresList?: string;
}

export interface ProactiveDeps {
	assistant: Assistant;
	home?: HomeApi;
	/** Message the owner on Discord. False when it could not be sent. */
	notify(text: string, what: "brief" | "bins" | "battery" | "mail"): Promise<boolean>;
	reminders(): Promise<Array<{ message: string; time: Date }>>;
	/** Something RemindMe did on its own, for the ledger. */
	did?(text: string): void;
	parcels?(): string;
	/** Gmail and GMX: checked every quarter hour outside quiet hours. */
	mail?: MailWatch;
	options: ProactiveOptions;
	statePath?: string;
}

interface State {
	briefDate?: string;
	binDate?: string;
	/** The bin chore added for tomorrow's collection: when, and its exact text. */
	binChore?: { date: string; item: string };
	/** entity_id → date of the last low-battery nudge. */
	batteries: Record<string, string>;
}

/** "07:30" → minutes after midnight, or undefined for blank or nonsense. */
export function minutesOf(value: string): number | undefined {
	const match = value.trim().match(/^(\d{1,2})[:.](\d{2})$/);
	if (!match) return undefined;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return undefined;
	return hours * 60 + minutes;
}

export function inQuietHours(window: string, at: Date): boolean {
	const [from, to] = window.split("-").map((part) => minutesOf(part || ""));
	if (from === undefined || to === undefined || from === to) return false;
	const now = at.getHours() * 60 + at.getMinutes();
	return from < to ? now >= from && now < to : now >= from || now < to;
}

const WASTE_CALENDAR = /abfall|müll|muell|waste|trash|garbage|bin|tonne|recycl/i;
const WASTE_EVENT = /tonne|müll|muell|abfall|waste|trash|garbage|recycling|wertstoff|altpapier/i;

/** German bin names in plain English, kept next to the original. */
const BIN_NAMES: Array<[RegExp, string]> = [
	[/blau|papier|paper/i, "paper"],
	[/gelb|wertstoff|verpackung|packaging/i, "packaging"],
	[/bio|organic/i, "organic"],
	[/rest|residual/i, "residual waste"],
	[/glas|glass/i, "glass"],
];

export function binLabel(summary: string): string {
	// "Blaue Tonne (Abholzeit)": the pickup-time note says nothing here.
	const name = summary.replace(/\s*\((abholzeit|abholung|leerung|pickup)[^)]*\)/gi, "").trim() || summary;
	const english = BIN_NAMES.find(([pattern]) => pattern.test(name))?.[1];
	return english && !name.toLowerCase().includes(english) ? `${english} (${name})` : name;
}

/** The chore for tomorrow's collection: "Put the paper bin out (Blaue Tonne)". */
export function binChore(events: CalendarEvent[]): string | undefined {
	const bins = [...new Set(wasteEvents(events).map((event) => binLabel(event.summary)))];
	if (!bins.length) return undefined;
	if (bins.length === 1) {
		const [, english, original] = bins[0].match(/^(.+?) \((.+)\)$/) || [];
		return english ? `Put the ${english} bin out (${original})` : `Put the ${bins[0]} bin out`;
	}
	return `Put the bins out: ${bins.join(", ")}`;
}

export function wasteEvents(events: CalendarEvent[]): CalendarEvent[] {
	return events.filter((event) => WASTE_CALENDAR.test(event.calendar) || WASTE_EVENT.test(event.summary));
}

export function binNudge(events: CalendarEvent[]): string | undefined {
	const bins = [...new Set(wasteEvents(events).map((event) => binLabel(event.summary)))];
	if (!bins.length) return undefined;
	const list = bins.length === 1 ? bins[0] : `${bins.slice(0, -1).join(", ")} and ${bins[bins.length - 1]}`;
	return `🗑️ Bins tonight: ${list}. Collection is tomorrow.`;
}

function startOfDay(at: Date, plusDays = 0): Date {
	const day = new Date(at);
	day.setHours(0, 0, 0, 0);
	day.setDate(day.getDate() + plusDays);
	return day;
}

/**
 * The assistant speaking first: a morning brief at a set time, the bins the
 * evening before collection, and batteries running out. The nudges are fixed
 * checks that need no AI; only the brief is written by the model.
 */
export class Proactive {
	private state: State = { batteries: {} };
	private running = false;
	private mailCheckedAt = 0;
	private readonly path: string;

	constructor(private readonly deps: ProactiveDeps) {
		this.path = deps.statePath || process.env.PROACTIVE_DATA_PATH || "./data/proactive.json";
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as State;
			this.state = { ...saved, batteries: saved.batteries || {} };
		} catch {
			this.state = { batteries: {} };
		}
	}

	private async save(): Promise<void> {
		try {
			await mkdir(dirname(this.path), { recursive: true });
			await writeFile(`${this.path}.tmp`, JSON.stringify(this.state));
			await rename(`${this.path}.tmp`, this.path);
		} catch (error) {
			console.warn("Could not save the nudge state:", error instanceof Error ? error.message : error);
		}
	}

	start(intervalMs = 60_000): ReturnType<typeof setInterval> {
		void this.tick();
		return setInterval(() => void this.tick(), intervalMs);
	}

	/** One check: is anything due? Runs every minute; each thing fires once a day at most. */
	async tick(now = new Date()): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const today = localDate(now);
			const minute = now.getHours() * 60 + now.getMinutes();
			const { options } = this.deps;
			const briefAt = minutesOf(options.briefTime);
			if (briefAt !== undefined && minute >= briefAt && minute < briefAt + 180 && this.state.briefDate !== today) {
				this.state.briefDate = today;
				await this.save();
				await this.sendBrief(now);
			}
			const choreAt = briefAt ?? 7 * 60;
			if (options.choresList && minute >= choreAt && this.state.binChore?.date !== today && this.deps.home) await this.addBinChore(now);
			if (inQuietHours(options.quietHours, now)) return;
			const binAt = minutesOf(options.binTime);
			if (binAt !== undefined && minute >= binAt && this.state.binDate !== today && this.deps.home) {
				const events = await this.deps.home.calendarEvents(startOfDay(now, 1), startOfDay(now, 2));
				const text = binNudge(events.filter((event) => event.start.slice(0, 10) === localDate(startOfDay(now, 1))));
				this.state.binDate = today;
				await this.save();
				// Ticked off already: no need to say it again.
				if (text && !(await this.binChoreDone(today))) await this.deps.notify(text, "bins");
			}
			if (options.batteryThreshold > 0) await this.checkBatteries(now);
			if (this.deps.mail && now.getTime() - this.mailCheckedAt >= 15 * 60_000) {
				this.mailCheckedAt = now.getTime();
				await this.deps.mail.check(now);
				await this.deps.mail.dueTomorrow(now);
			}
		} catch (error) {
			console.warn("Nudge check failed:", error instanceof Error ? error.message : error);
		} finally {
			this.running = false;
		}
	}

	/** The morning before a collection: the bins go on the chores list, due today. */
	private async addBinChore(now: Date): Promise<void> {
		const home = this.deps.home!;
		const today = localDate(now);
		const tomorrow = localDate(startOfDay(now, 1));
		const events = await home.calendarEvents(startOfDay(now, 1), startOfDay(now, 2));
		const item = binChore(events.filter((event) => event.start.slice(0, 10) === tomorrow));
		this.state.binChore = { date: today, item: item || "" };
		await this.save();
		if (!item) return;
		try {
			await home.callService("todo", "add_item", { entity_id: this.deps.options.choresList, item, due_date: today });
			this.deps.did?.(`Added "${item}" to the chores`);
		} catch (error) {
			console.warn("Could not add the bin chore:", error instanceof Error ? error.message : error);
		}
	}

	/** Whether today's bin chore is off the list (ticked off, or removed). */
	private async binChoreDone(today: string): Promise<boolean> {
		const chore = this.state.binChore;
		const list = this.deps.options.choresList;
		if (!chore?.item || chore.date !== today || !list || !this.deps.home) return false;
		try {
			const response = await this.deps.home.serviceResponse("todo", "get_items", { entity_id: list, status: ["needs_action"] });
			const items = (response[list] as { items?: Array<{ summary?: string }> })?.items || [];
			return !items.some((entry) => entry.summary === chore.item);
		} catch {
			return false;
		}
	}

	private async checkBatteries(now: Date): Promise<void> {
		const home = this.deps.home;
		if (!home) return;
		const weekAgo = localDate(new Date(now.getTime() - 7 * 86_400_000));
		const low = (await home.cards()).filter(
			(card) =>
				card.available &&
				card.deviceClass === "battery" &&
				card.numericState !== undefined &&
				card.numericState <= this.deps.options.batteryThreshold &&
				!((this.state.batteries[card.entityId] || "") > weekAgo),
		);
		if (!low.length) return;
		const names = low.map((card) => `${card.name.replace(/\s*battery$/i, "")} at ${Math.round(card.numericState!)}%`);
		const sent = await this.deps.notify(
			low.length === 1 ? `🔋 ${names[0]}. Time for a new battery.` : `🔋 Batteries running low: ${names.join(", ")}.`,
			"battery",
		);
		if (!sent) return;
		for (const card of low) this.state.batteries[card.entityId] = localDate(now);
		await this.save();
	}

	/** The facts behind the brief, gathered without the model so nothing is missed. */
	async briefFacts(now = new Date()): Promise<Record<string, unknown>> {
		const facts: Record<string, unknown> = {};
		const home = this.deps.home;
		if (home) {
			try {
				const events = await home.calendarEvents(startOfDay(now), startOfDay(now, 2));
				const waste = new Set(wasteEvents(events));
				facts.today_and_tomorrow = events.filter((event) => !waste.has(event)).slice(0, 25);
				const tomorrow = localDate(startOfDay(now, 1));
				facts.bins_out_tonight = [...waste].filter((event) => event.start.slice(0, 10) === tomorrow).map((event) => binLabel(event.summary));
			} catch (error) {
				facts.calendar_error = error instanceof Error ? error.message : String(error);
			}
			try {
				const cards = await home.cards();
				const weather = cards.find((card) => card.domain === "weather" && card.available);
				if (weather) {
					const response = await home.serviceResponse("weather", "get_forecasts", { entity_id: weather.entityId, type: "daily" });
					const day = (response[weather.entityId] as { forecast?: Array<Record<string, unknown>> })?.forecast?.[0];
					facts.weather = { now: stateText(weather), today: day };
				}
				facts.low_batteries = cards
					.filter((card) => card.available && card.deviceClass === "battery" && card.numericState !== undefined && card.numericState <= 20)
					.map((card) => `${card.name} ${card.numericState}%`);
				facts.lights_on = cards.filter((card) => card.domain === "light" && card.state === "on").map((card) => card.name);
			} catch (error) {
				facts.home_error = error instanceof Error ? error.message : String(error);
			}
		}
		try {
			const end = startOfDay(now, 1).getTime();
			facts.reminders_today = (await this.deps.reminders())
				.filter((reminder) => reminder.time.getTime() < end)
				.map((reminder) => ({ message: reminder.message, at: reminder.time.toTimeString().slice(0, 5) }));
		} catch {
			// Reminders are optional here.
		}
		const parcels = this.deps.parcels?.();
		if (parcels && !/^No parcels/.test(parcels)) facts.parcels = parcels;
		const mail = this.deps.mail?.digest() || [];
		if (mail.length)
			facts.new_mail = mail.map((item) => ({ account: item.account, from: item.from, subject: item.subject, kind: item.label, preview: item.snippet.slice(0, 120) }));
		return facts;
	}

	/** Write the brief and send it. Falls back to a plain list if the AI can't. */
	async sendBrief(now = new Date()): Promise<string> {
		// Overnight mail goes into the brief rather than arriving as separate messages.
		if (this.deps.mail) {
			await this.deps.mail.check(now, { announce: false });
			this.mailCheckedAt = now.getTime();
		}
		const facts = await this.briefFacts(now);
		const result = await this.deps.assistant.ask({
			prompt: "Write my morning brief.",
			channel: "brief",
			effort: "medium",
			extra: `Facts gathered for the brief, as JSON. Use your tools only if something important is missing.\n${JSON.stringify(facts)}`,
		});
		const text = result.problem ? plainBrief(facts, result.problem) : result.text;
		if ((await this.deps.notify(text, "brief")) && this.deps.mail) await this.deps.mail.clearDigest();
		return text;
	}

	private binsCache?: { day: string; text?: string };

	/**
	 * What RemindMe will send next on its own: the brief and tonight's bins.
	 * For the console's ledger; the calendar is read at most once a day here.
	 */
	async upcoming(now = new Date()): Promise<Array<{ at: Date; text: string }>> {
		const { options } = this.deps;
		const planned: Array<{ at: Date; text: string }> = [];
		const today = localDate(now);
		const at = (day: Date, minutes: number) => new Date(startOfDay(day).getTime() + minutes * 60_000);
		const briefAt = minutesOf(options.briefTime);
		if (briefAt !== undefined) {
			const minute = now.getHours() * 60 + now.getMinutes();
			const todayStill = this.state.briefDate !== today && minute < briefAt;
			planned.push({ at: at(todayStill ? now : startOfDay(now, 1), briefAt), text: "Morning brief to Discord" });
		}
		const binAt = minutesOf(options.binTime);
		if (binAt !== undefined && this.state.binDate !== today && this.deps.home) {
			if (this.binsCache?.day !== today) {
				const tomorrow = localDate(startOfDay(now, 1));
				try {
					const events = await this.deps.home.calendarEvents(startOfDay(now, 1), startOfDay(now, 2));
					this.binsCache = { day: today, text: binNudge(events.filter((event) => event.start.slice(0, 10) === tomorrow)) };
				} catch {
					this.binsCache = { day: today };
				}
			}
			if (this.binsCache.text) planned.push({ at: at(now, binAt), text: this.binsCache.text.replace(/^🗑️ /, "") });
		}
		return planned;
	}
}

/** The brief without the AI: the same facts, as a short list. */
export function plainBrief(facts: Record<string, unknown>, problem: string): string {
	const lines: string[] = [];
	const events = (facts.today_and_tomorrow as CalendarEvent[] | undefined) || [];
	for (const event of events.slice(0, 6))
		lines.push(`**${event.allDay ? event.start : event.start.slice(0, 16).replace("T", " ")}** ${event.summary}`);
	const bins = facts.bins_out_tonight as string[] | undefined;
	if (bins?.length) lines.push(`**Tonight** ${bins.join(", ")} out`);
	const weather = facts.weather as { now?: string } | undefined;
	if (weather?.now) lines.push(`**Weather** ${weather.now}`);
	const mail = facts.new_mail as Array<{ from: string; subject: string }> | undefined;
	if (mail?.length) lines.push(`**Mail** ${mail.length} new worth a look, latest: ${mail[mail.length - 1].subject}`);
	const batteries = facts.low_batteries as string[] | undefined;
	if (batteries?.length) lines.push(`**House** Low batteries: ${batteries.join(", ")}`);
	lines.push(`_Plain version: ${problem.replace(/\.$/, "")}._`);
	return lines.join("\n");
}
