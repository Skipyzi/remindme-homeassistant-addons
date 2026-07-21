import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Reminders are shared by two processes: the console writes them and the
 * bot delivers them, because only the bot holds the Discord client and the
 * notify target. They used to be kept in a module-level map per process
 * and flushed wholesale, so each process overwrote the other's reminders
 * every time it saved, and a reminder created in the console was never
 * seen by the side that could deliver it.
 *
 * The file is the record now. Every change is a read-modify-write of it,
 * and the bot's scheduler treats its timers as a cache of what the file
 * says rather than as the truth. Writes are serialised inside a process
 * and land via a temporary file and a rename, so a reader never sees a
 * half-written list.
 */

export type DeliveryState = "pending" | "delivered" | "failed" | "skipped";

export interface Reminder {
	id: string;
	message: string;
	time: Date;
	createdAt: Date;
	userId: string;
	channelId: string;
	notified: boolean;
	deliveryStatus?: Record<string, DeliveryState>;
}

type StoredReminder = Omit<Reminder, "time" | "createdAt"> & {
	time: string;
	createdAt: string;
};

export type DueHandler = (
	reminder: Reminder,
) => Promise<Record<string, DeliveryState> | void>;

const dataPath = process.env.REMINDER_DATA_PATH || "./data/reminders.json";

/** How long a delivered reminder is kept before it is swept away. */
const RETENTION_MS = 5 * 60_000;
/** How often the bot re-reads the file to notice work from the console. */
const POLL_MS = 5_000;
/** How long to wait before retrying a reminder that did not fully deliver. */
const RETRY_MS = 60_000;

function revive(item: StoredReminder): Reminder {
	return {
		...item,
		time: new Date(item.time),
		createdAt: new Date(item.createdAt),
	};
}

async function readAll(): Promise<Reminder[]> {
	try {
		const parsed = JSON.parse(await readFile(dataPath, "utf8"));
		return Array.isArray(parsed) ? parsed.map(revive) : [];
	} catch (error: unknown) {
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
		if (code !== "ENOENT") console.error("Failed to read reminders:", error);
		return [];
	}
}

async function writeAll(list: Reminder[]): Promise<void> {
	await mkdir(dirname(dataPath), { recursive: true });
	const temporary = `${dataPath}.tmp`;
	await writeFile(temporary, JSON.stringify(list, null, 2), "utf8");
	await rename(temporary, dataPath);
}

/*
 * One change at a time within this process. Two processes can still
 * interleave a read and a write, but reminders are created a handful of
 * times a day and the window is a couple of milliseconds wide — worth
 * naming rather than worth a lock file on an SD card.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialise<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.catch(() => undefined);
	return run;
}

async function mutate<T>(
	change: (list: Reminder[]) => { list: Reminder[]; result: T },
): Promise<T> {
	return serialise(async () => {
		const { list, result } = change(await readAll());
		await writeAll(list);
		return result;
	});
}

export async function addReminder(
	message: string,
	delayMinutes: number,
	userId: string,
	channelId: string,
): Promise<Reminder> {
	const reminder: Reminder = {
		id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		message,
		time: new Date(Date.now() + delayMinutes * 60_000),
		createdAt: new Date(),
		userId,
		channelId,
		notified: false,
	};
	await mutate((list) => ({ list: [...list, reminder], result: undefined }));
	return reminder;
}

export async function getReminder(id: string): Promise<Reminder | undefined> {
	return (await readAll()).find((reminder) => reminder.id === id);
}

export async function listReminders(userId: string): Promise<Reminder[]> {
	return (await readAll())
		.filter((reminder) => reminder.userId === userId && !reminder.notified)
		.sort((a, b) => a.time.getTime() - b.time.getTime());
}

export async function countReminders(userId: string): Promise<number> {
	return userId ? (await listReminders(userId)).length : 0;
}

export async function deleteReminder(
	id: string,
	userId: string,
): Promise<boolean> {
	return mutate((list) => {
		const match = list.find(
			(reminder) => reminder.id === id && reminder.userId === userId,
		);
		if (!match) return { list, result: false };
		return {
			list: list.filter((reminder) => reminder !== match),
			result: true,
		};
	});
}

export async function cleanupExpiredReminders(): Promise<void> {
	const expiry = Date.now() - RETENTION_MS;
	await mutate((list) => ({
		list: list.filter(
			(reminder) => !reminder.notified || reminder.time.getTime() >= expiry,
		),
		result: undefined,
	}));
}

/* ── Scheduling: the bot process only ─────────────────────────────────── */

const timers = new Map<string, ReturnType<typeof setTimeout>>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

let retryDelay = RETRY_MS;

function arm(reminder: Reminder, onDue: DueHandler, delayMs?: number): void {
	const delay = delayMs ?? Math.max(0, reminder.time.getTime() - Date.now());
	timers.set(
		reminder.id,
		setTimeout(() => void fire(reminder.id, onDue), delay),
	);
}

async function fire(id: string, onDue: DueHandler): Promise<void> {
	timers.delete(id);
	// Re-read: the console may have deleted it, or another pass delivered it.
	const reminder = await getReminder(id);
	if (!reminder || reminder.notified) return;

	let status: Record<string, DeliveryState> | void = undefined;
	let threw = false;
	try {
		status = await onDue(reminder);
	} catch (error) {
		threw = true;
		console.error("Failed to deliver reminder:", error);
	}
	const settled =
		!threw &&
		(!status ||
			Object.values(status).every(
				(state) => state === "delivered" || state === "skipped",
			));
	if (status && Object.values(status).every((state) => state === "skipped"))
		console.warn(
			`Reminder ${id} had no delivery target: set OWNER_ID, or create it from Discord so it has a channel.`,
		);

	await mutate((list) => {
		const match = list.find((item) => item.id === id);
		if (match) {
			if (status) match.deliveryStatus = status;
			match.notified = settled;
		}
		return { list, result: undefined };
	});
	if (!settled) arm(reminder, onDue, retryDelay);
}

/**
 * Watch the file and keep a timer armed for everything still due.
 *
 * Polling rather than a file watcher: this runs on a Pi against a file the
 * other process rewrites via rename, which fs.watch reports inconsistently
 * across platforms. A five second sweep is cheap and cannot miss an event.
 */
export function startReminderScheduler(
	onDue: DueHandler,
	options: { pollMs?: number; retryMs?: number } = {},
): void {
	const pollMs = options.pollMs ?? POLL_MS;
	retryDelay = options.retryMs ?? RETRY_MS;
	const sweep = async () => {
		const list = await readAll();
		const live = new Set<string>();
		for (const reminder of list) {
			if (reminder.notified) continue;
			live.add(reminder.id);
			if (!timers.has(reminder.id)) arm(reminder, onDue);
		}
		for (const [id, timer] of timers) {
			if (live.has(id)) continue;
			clearTimeout(timer);
			timers.delete(id);
		}
	};
	void sweep();
	pollTimer = setInterval(() => void sweep(), pollMs);
	cleanupTimer = setInterval(() => void cleanupExpiredReminders(), 60_000);
}

export function stopReminderSystem(): void {
	if (pollTimer) clearInterval(pollTimer);
	if (cleanupTimer) clearInterval(cleanupTimer);
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
}
