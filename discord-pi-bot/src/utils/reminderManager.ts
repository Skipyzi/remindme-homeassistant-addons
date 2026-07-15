export interface Reminder {
	id: string;
	message: string;
	time: Date;
	createdAt: Date;
	userId: string;
	channelId: string;
	notified: boolean;
}

const reminders = new Map<string, Reminder>();
let cleanupTimer: ReturnType<typeof setInterval> | undefined;

export function setReminder(
	message: string,
	delayMinutes: number,
	userId: string,
	channelId: string,
	onDue: (reminder: Reminder) => Promise<void>,
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

	setTimeout(async () => {
		if (reminder.notified || !reminders.has(reminder.id)) return;
		reminder.notified = true;
		try {
			await onDue(reminder);
		} catch (error) {
			console.error("Failed to deliver reminder:", error);
		}
	}, delayMinutes * 60_000);

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
	return reminders.delete(id);
}

export function cleanupExpiredReminders(): void {
	const expiry = Date.now() - 5 * 60_000;
	for (const [id, reminder] of reminders) {
		if (reminder.notified && reminder.time.getTime() < expiry)
			reminders.delete(id);
	}
}

export function startPeriodicCleanup(): void {
	cleanupTimer = setInterval(cleanupExpiredReminders, 60_000);
}

export function stopReminderSystem(): void {
	if (cleanupTimer) clearInterval(cleanupTimer);
}
