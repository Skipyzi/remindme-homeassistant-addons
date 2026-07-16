import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface Reminder {
	id: string;
	message: string;
	time: Date;
	createdAt: Date;
	userId: string;
	channelId: string;
	notified: boolean;
	deliveryStatus?: Record<
		string,
		"pending" | "delivered" | "failed" | "skipped"
	>;
}

type DueHandler = (
	reminder: Reminder,
) => Promise<Record<
	string,
	"pending" | "delivered" | "failed" | "skipped"
> | void>;
const reminders = new Map<string, Reminder>();
const handlers = new Map<string, DueHandler>();
let cleanupTimer: ReturnType<typeof setInterval> | undefined;
const dataPath = process.env.REMINDER_DATA_PATH || "./data/reminders.json";

async function persist(): Promise<void> {
	await mkdir(dirname(dataPath), { recursive: true });
	await writeFile(
		dataPath,
		JSON.stringify([...reminders.values()], null, 2),
		"utf8",
	);
}

function schedule(
	reminder: Reminder,
	onDue: DueHandler,
	retryDelay?: number,
): void {
	handlers.set(reminder.id, onDue);
	const delay = retryDelay ?? Math.max(0, reminder.time.getTime() - Date.now());
	setTimeout(async () => {
		if (reminder.notified || !reminders.has(reminder.id)) return;
		try {
			const status = await onDue(reminder);
			if (status) reminder.deliveryStatus = status;
			reminder.notified =
				!status ||
				Object.values(status).every(
					(value) => value === "delivered" || value === "skipped",
				);
			await persist();
			if (!reminder.notified) schedule(reminder, onDue, 60_000);
		} catch (error) {
			console.error("Failed to deliver reminder:", error);
			schedule(reminder, onDue, 60_000);
		}
	}, delay);
}

export async function loadReminders(onDue: DueHandler): Promise<void> {
	try {
		const raw = await readFile(dataPath, "utf8");
		const saved = JSON.parse(raw) as Array<
			Reminder & { time: string; createdAt: string }
		>;
		for (const item of saved) {
			if (item.notified) continue;
			const reminder: Reminder = {
				...item,
				time: new Date(item.time),
				createdAt: new Date(item.createdAt),
			};
			reminders.set(reminder.id, reminder);
			schedule(reminder, onDue);
		}
	} catch (error: unknown) {
		const code =
			error && typeof error === "object" && "code" in error
				? error.code
				: undefined;
		if (code !== "ENOENT") console.error("Failed to load reminders:", error);
	}
}

export function setReminder(
	message: string,
	delayMinutes: number,
	userId: string,
	channelId: string,
	onDue: DueHandler,
): Reminder {
	const reminder: Reminder = {
		id: `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
		message,
		time: new Date(Date.now() + delayMinutes * 60_000),
		createdAt: new Date(),
		userId,
		channelId,
		notified: false,
	};
	reminders.set(reminder.id, reminder);
	schedule(reminder, onDue);
	void persist();
	return reminder;
}

export function getReminder(id: string): Reminder | undefined {
	return reminders.get(id);
}

export function getReminders(userId: string): Reminder[] {
	return [...reminders.values()]
		.filter((reminder) => reminder.userId === userId && !reminder.notified)
		.sort((a, b) => a.time.getTime() - b.time.getTime());
}

export function deleteReminder(id: string, userId: string): boolean {
	const reminder = reminders.get(id);
	if (!reminder || reminder.userId !== userId) return false;
	handlers.delete(id);
	const deleted = reminders.delete(id);
	void persist();
	return deleted;
}

export function cleanupExpiredReminders(): void {
	const expiry = Date.now() - 5 * 60_000;
	for (const [id, reminder] of reminders) {
		if (reminder.notified && reminder.time.getTime() < expiry) {
			reminders.delete(id);
			handlers.delete(id);
		}
	}
	void persist();
}

export function startPeriodicCleanup(): void {
	cleanupTimer = setInterval(cleanupExpiredReminders, 60_000);
}

export function stopReminderSystem(): void {
	if (cleanupTimer) clearInterval(cleanupTimer);
}
