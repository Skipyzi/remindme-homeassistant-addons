import type { Reminder } from "../utils/reminderManager";

export type DeliveryState = "pending" | "delivered" | "failed" | "skipped";
export interface ReminderDeliveryStatus {
	[key: string]: DeliveryState;
	homeAssistant: DeliveryState;
	mobile: DeliveryState;
	discord: DeliveryState;
}
export interface DeliveryAdapters {
	homeAssistant: (reminder: Reminder) => Promise<void>;
	mobile?: (reminder: Reminder) => Promise<void>;
	discord: (reminder: Reminder) => Promise<void>;
}

export function deliveryTargets(
	reminder: Reminder,
	ownerId: string,
): ReminderDeliveryStatus {
	const isOwner = Boolean(ownerId) && reminder.userId === ownerId;
	return {
		homeAssistant: isOwner ? "pending" : "skipped",
		mobile: isOwner ? "pending" : "skipped",
		discord: "pending",
	};
}

export async function deliverReminder(
	reminder: Reminder,
	ownerId: string,
	adapters: DeliveryAdapters,
	status = deliveryTargets(reminder, ownerId),
): Promise<ReminderDeliveryStatus> {
	const next = { ...status };
	async function attempt(
		key: keyof ReminderDeliveryStatus,
		operation?: () => Promise<void>,
	) {
		if (next[key] === "delivered" || next[key] === "skipped") return;
		if (!operation) {
			next[key] = "skipped";
			return;
		}
		try {
			await operation();
			next[key] = "delivered";
		} catch {
			next[key] = "failed";
		}
	}
	await attempt("homeAssistant", () => adapters.homeAssistant(reminder));
	await attempt(
		"mobile",
		adapters.mobile
			? () => adapters.mobile?.(reminder) as Promise<void>
			: undefined,
	);
	await attempt("discord", () => adapters.discord(reminder));
	return next;
}
