import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * A scheduled task is a standing prompt the harness runs on a cadence — a
 * daily report, a "what happened yesterday" recap, a "cheapest X, list every
 * listing" watch. Unlike a reminder, which fires a fixed message, a task runs
 * a full model turn with tools each time and delivers whatever it produced.
 *
 * The harness owns the whole lifecycle: it holds the model, the tools, and the
 * vault, so it schedules, runs, and archives here. Only Discord/mobile delivery
 * crosses back to the bot process, and it does so by enqueuing an ordinary
 * one-shot reminder rather than inventing a second cross-process channel.
 *
 * Schedules are parsed deterministically for the same reason reminders are: a
 * small model is unreliable at "every second tuesday" and the cadences people
 * actually want are a short list.
 */

/**
 * Where a run's output goes. `vault` archives the full report as a note;
 * `notify` enqueues a one-shot reminder with the headline, which the bot's
 * existing pipeline fans out to Home Assistant, mobile, and Discord exactly as
 * it configures them — so a task inherits reminder delivery rather than
 * reinventing it.
 */
export type DeliveryTarget = "vault" | "notify";

export type TaskSchedule =
	| { kind: "daily"; time: string }
	| { kind: "weekly"; weekday: number; time: string }
	| { kind: "interval"; minutes: number };

export interface ScheduledTask {
	id: string;
	name: string;
	/** The instruction handed to the model each run. */
	prompt: string;
	schedule: TaskSchedule;
	deliver: DeliveryTarget[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	/** ISO of the last completed run, if any. */
	lastRun?: string;
	lastStatus?: "ok" | "error";
	/** A short line for the UI — never the whole report. */
	lastSummary?: string;
	/** Vault path of the last archived report, when delivered there. */
	lastNotePath?: string;
	/** ISO of the next scheduled fire. */
	nextRun: string;
	/**
	 * Discord channel to deliver into, when the task was created from Discord.
	 * Console-created tasks have none; their `notify` runs still reach Home
	 * Assistant and mobile, which need only the owner id.
	 */
	channelId?: string;
}

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

/** Clamp and format an hour/minute pair as `HH:MM`. */
function clockTime(hour: number, minutes: number): string {
	const h = Math.min(23, Math.max(0, hour));
	const m = Math.min(59, Math.max(0, minutes));
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Read a `[at] H[:MM] [am|pm]` clause. Bare hours are read literally — a daily
 * task "at 8" means 08:00, not the evening a one-off reminder would assume,
 * because a scheduled report at a plain hour is almost always the morning one.
 */
function readTime(text: string, fallback = "08:00"): string {
	const match = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
	if (!match) return fallback;
	let hour = Number(match[1]);
	const minutes = Number(match[2] || 0);
	const suffix = match[3]?.toLowerCase();
	if (suffix === "pm" && hour < 12) hour += 12;
	if (suffix === "am" && hour === 12) hour = 0;
	if (hour > 23) return fallback;
	return clockTime(hour, minutes);
}

/**
 * Match a cadence in text and report where it was found, so a free-text task
 * can have its schedule phrase lifted out and the rest kept as the prompt.
 */
function matchSchedule(
	input: string,
): { schedule: TaskSchedule; span: [number, number] } | undefined {
	const text = String(input || "");

	// "every 30 minutes", "every 2 hours"
	const interval = text.match(
		/\bevery\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|h|m)\b/i,
	);
	if (interval && interval.index != null) {
		const amount = Number(interval[1]);
		const minutes = interval[2].toLowerCase().startsWith("h") ? amount * 60 : amount;
		if (minutes >= 1)
			return {
				schedule: { kind: "interval", minutes },
				span: [interval.index, interval.index + interval[0].length],
			};
	}

	// "weekly on monday at 9", "every monday 9am", "mondays at 9"
	const weekly = text.match(
		new RegExp(
			`\\b(?:weekly\\s+)?(?:on\\s+|every\\s+)?(${WEEKDAYS.map((day) => `${day}s?`).join("|")})\\b(\\s+(?:at\\s+)?\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)?`,
			"i",
		),
	);
	if (weekly && weekly.index != null) {
		const index = WEEKDAYS.indexOf(weekly[1].toLowerCase().replace(/s$/, ""));
		if (index >= 0)
			return {
				schedule: { kind: "weekly", weekday: index, time: readTime(weekly[0]) },
				span: [weekly.index, weekly.index + weekly[0].length],
			};
	}

	// "daily at 8", "every day 07:30", or a bare "at 6pm"
	const daily = text.match(
		/\b(?:daily|every day|each day)\b(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?|\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?/i,
	);
	if (daily && daily.index != null)
		return {
			schedule: { kind: "daily", time: readTime(daily[0]) },
			span: [daily.index, daily.index + daily[0].length],
		};

	return undefined;
}

/**
 * Parse a cadence from plain words. Returns undefined when nothing usable is
 * found, so the caller can ask rather than guess.
 */
export function parseSchedule(input: string): TaskSchedule | undefined {
	return matchSchedule(input)?.schedule;
}

/**
 * Split a free-text task into its cadence and the instruction that remains.
 * "every day at 8 summarise yesterday" → the daily schedule plus "summarise
 * yesterday". Leading filler like "to" or "and" left behind is trimmed.
 */
export function extractSchedule(input: string): {
	schedule?: TaskSchedule;
	rest: string;
} {
	const text = String(input || "").trim();
	const found = matchSchedule(text);
	if (!found) return { rest: text };
	const [start, end] = found.span;
	const rest = (text.slice(0, start) + " " + text.slice(end))
		.replace(/\s{2,}/g, " ")
		.replace(/^\s*(?:to|and|please|,)\s+/i, "")
		.trim();
	return { schedule: found.schedule, rest };
}

/** A schedule as a short human phrase, for confirmations and the UI. */
export function describeSchedule(schedule: TaskSchedule): string {
	if (schedule.kind === "interval") {
		if (schedule.minutes % 60 === 0) {
			const hours = schedule.minutes / 60;
			return `every ${hours} hour${hours === 1 ? "" : "s"}`;
		}
		return `every ${schedule.minutes} minute${schedule.minutes === 1 ? "" : "s"}`;
	}
	if (schedule.kind === "weekly")
		return `every ${WEEKDAYS[schedule.weekday]} at ${schedule.time}`;
	return `daily at ${schedule.time}`;
}

function atClock(base: Date, time: string): Date {
	const [hour, minute] = time.split(":").map(Number);
	const date = new Date(base);
	date.setHours(hour, minute, 0, 0);
	return date;
}

/**
 * When the task next fires, strictly after `from`. For intervals the step is
 * measured from `from` — pass the last run to keep a steady cadence, or now to
 * schedule the first one.
 */
export function computeNextRun(schedule: TaskSchedule, from = new Date()): Date {
	if (schedule.kind === "interval")
		return new Date(from.getTime() + schedule.minutes * 60_000);
	if (schedule.kind === "daily") {
		const next = atClock(from, schedule.time);
		if (next <= from) next.setDate(next.getDate() + 1);
		return next;
	}
	// weekly
	const next = atClock(from, schedule.time);
	const delta = (schedule.weekday - next.getDay() + 7) % 7;
	next.setDate(next.getDate() + delta);
	if (next <= from) next.setDate(next.getDate() + 7);
	return next;
}

const DEFAULT_DELIVERY: DeliveryTarget[] = ["vault", "notify"];

function normalizeDelivery(value: unknown): DeliveryTarget[] {
	const all: DeliveryTarget[] = ["vault", "notify"];
	if (!Array.isArray(value)) return [...DEFAULT_DELIVERY];
	const chosen = all.filter((target) => value.includes(target));
	return chosen.length ? chosen : [...DEFAULT_DELIVERY];
}

export class TaskStore {
	private tasks: ScheduledTask[] = [];
	constructor(
		private readonly path = process.env.TASK_DATA_PATH || "./data/tasks.json",
	) {}

	async load(): Promise<void> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			this.tasks = Array.isArray(parsed) ? (parsed as ScheduledTask[]) : [];
		} catch (error) {
			if (
				!(
					error &&
					typeof error === "object" &&
					"code" in error &&
					(error as { code?: string }).code === "ENOENT"
				)
			)
				console.error("Failed to load tasks:", error);
			this.tasks = [];
		}
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp`;
		await writeFile(temporary, JSON.stringify(this.tasks, null, 2), "utf8");
		await rename(temporary, this.path);
	}

	list(): ScheduledTask[] {
		return this.tasks;
	}

	get(id: string): ScheduledTask | undefined {
		return this.tasks.find((task) => task.id === id);
	}

	/** Enabled tasks whose next run has arrived by `now`. */
	due(now = new Date()): ScheduledTask[] {
		return this.tasks.filter(
			(task) => task.enabled && new Date(task.nextRun) <= now,
		);
	}

	async create(values: Partial<ScheduledTask>): Promise<ScheduledTask> {
		const schedule =
			values.schedule && "kind" in values.schedule
				? values.schedule
				: ({ kind: "daily", time: "08:00" } as TaskSchedule);
		const now = new Date();
		const iso = now.toISOString();
		const task: ScheduledTask = {
			id: randomUUID(),
			name: String(values.name || "Untitled task").slice(0, 80),
			prompt: String(values.prompt || "").slice(0, 2000),
			schedule,
			deliver: normalizeDelivery(values.deliver),
			enabled: values.enabled !== false,
			createdAt: iso,
			updatedAt: iso,
			nextRun: computeNextRun(schedule, now).toISOString(),
			channelId:
				typeof values.channelId === "string" && values.channelId
					? values.channelId
					: undefined,
		};
		this.tasks.unshift(task);
		await this.persist();
		return task;
	}

	async update(
		id: string,
		values: Partial<ScheduledTask>,
	): Promise<ScheduledTask | undefined> {
		const task = this.get(id);
		if (!task) return undefined;
		if (typeof values.name === "string") task.name = values.name.slice(0, 80);
		if (typeof values.prompt === "string")
			task.prompt = values.prompt.slice(0, 2000);
		if (typeof values.enabled === "boolean") task.enabled = values.enabled;
		if (values.deliver) task.deliver = normalizeDelivery(values.deliver);
		if (values.schedule && "kind" in values.schedule) {
			task.schedule = values.schedule;
			// A changed cadence re-bases the next run from now.
			task.nextRun = computeNextRun(task.schedule).toISOString();
		}
		task.updatedAt = new Date().toISOString();
		await this.persist();
		return task;
	}

	/**
	 * Record a completed run and roll the next fire forward. Interval cadences
	 * step from the run just finished so the rhythm holds; daily and weekly
	 * ones simply seek the next slot after now.
	 */
	async recordRun(
		id: string,
		outcome: {
			status: "ok" | "error";
			summary?: string;
			notePath?: string;
			at?: Date;
			/** Roll the next scheduled fire forward. Off for a manual run. */
			reschedule?: boolean;
		},
	): Promise<ScheduledTask | undefined> {
		const task = this.get(id);
		if (!task) return undefined;
		const at = outcome.at || new Date();
		task.lastRun = at.toISOString();
		task.lastStatus = outcome.status;
		if (outcome.summary !== undefined)
			task.lastSummary = outcome.summary.slice(0, 280);
		if (outcome.notePath !== undefined) task.lastNotePath = outcome.notePath;
		if (outcome.reschedule !== false)
			task.nextRun = computeNextRun(
				task.schedule,
				task.schedule.kind === "interval" ? at : new Date(),
			).toISOString();
		task.updatedAt = new Date().toISOString();
		await this.persist();
		return task;
	}

	async delete(id: string): Promise<boolean> {
		const before = this.tasks.length;
		this.tasks = this.tasks.filter((task) => task.id !== id);
		if (this.tasks.length === before) return false;
		await this.persist();
		return true;
	}
}
