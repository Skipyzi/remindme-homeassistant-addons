import type { ActivityLog } from "./assistant/activity";
import { deliverReminder, deliveryTargets } from "./harness/reminderDelivery";
import type { PhoneNotice } from "./phone/ha-app";
import { addReminder, startReminderScheduler, type Reminder } from "./utils/reminderManager";

/**
 * Due reminders go out to Home Assistant, the phone and, when wanted,
 * Discord. It runs whether or not a Discord bot is set up: Discord is one
 * way out, not the clock. A reminder made in a Discord channel always
 * answers there; a private one goes to the DMs only while the owner wants
 * RemindMe's messages on Discord.
 */
export function startReminders(deps: {
	ownerId: string;
	activity?: ActivityLog;
	phone?: { devices(): number; send(message: PhoneNotice): Promise<number> };
	/** Delivers to Discord; absent without a bot. */
	discord?: (reminder: Reminder) => Promise<void>;
	/** Whether private reminders go to Discord too (Settings → Discord). */
	discordWanted: () => boolean;
}): void {
	const callHomeAssistant = async (service: string, data: Record<string, unknown>) => {
		const token = process.env.SUPERVISOR_TOKEN;
		if (!token) throw new Error("Home Assistant API token unavailable");
		const response = await fetch(`${process.env.HA_API_URL || "http://supervisor/core/api"}/services/${service}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify(data),
		});
		if (!response.ok) throw new Error(`Home Assistant notification failed: ${response.status}`);
	};
	startReminderScheduler(async (reminder) => {
		const toDiscord = deps.discord && (reminder.channelId || deps.discordWanted()) ? deps.discord : undefined;
		const delivered = await deliverReminder(
			reminder,
			deps.ownerId,
			{
				homeAssistant: () => callHomeAssistant("persistent_notification/create", { title: "RemindMe", message: reminder.message, notification_id: reminder.id }),
				// The Home Assistant app (ha_notify_target, or the phone picked in Settings) goes through phone, with its buttons.
				mobile: undefined,
				phone: deps.phone?.devices()
					? async () => {
							const sent = await deps.phone!.send({
								title: "Reminder",
								body: reminder.message,
								url: "./#t/remindme",
								tag: `reminder-${reminder.id}`,
								buttons: [
									{
										title: "In 1 hour",
										run: async () => {
											await addReminder(reminder.message, 60, reminder.userId, reminder.channelId);
											return "I'll remind you again in an hour.";
										},
									},
								],
							});
							if (!sent) throw new Error("No phone took the reminder");
						}
					: undefined,
				discord: toDiscord ? () => toDiscord(reminder) : undefined,
			},
			/*
			 * Resume from what was already delivered. Without this a retry
			 * starts every channel afresh, so one unreachable Discord channel
			 * meant a fresh Home Assistant notification and phone push every
			 * minute for as long as it stayed unreachable.
			 */
			{ ...deliveryTargets(reminder, deps.ownerId), ...(reminder.deliveryStatus || {}) },
		);
		// Into the ledger once, when the first channel gets it.
		const before = Object.values(reminder.deliveryStatus || {}).includes("delivered");
		if (!before && Object.values(delivered).includes("delivered"))
			deps.activity?.add({ kind: "sent", channel: "reminder", text: `Reminder: ${reminder.message}`, actions: [{ label: "In 1 hour", kind: "reminder-later", ref: reminder.message }] });
		return delivered;
	});
}
