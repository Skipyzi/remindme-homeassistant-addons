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
		/*
		 * Discord has a recipient either way: a channel reminder answers in its
		 * channel, and a reminder with no channel — one set from the LLM console
		 * — is delivered as a direct message to its owner. Only a reminder with
		 * neither a channel nor a user is genuinely undeliverable and skipped,
		 * so it does not retry against nothing once a minute for ever.
		 */
		discord: reminder.channelId || reminder.userId ? "pending" : "skipped",
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
