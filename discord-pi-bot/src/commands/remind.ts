import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
} from "discord.js";
import { askLocalLlm } from "../localLlm";
import { config } from "../config";
import {
	deleteReminder,
	rescheduleReminder,
	type Reminder,
} from "../utils/reminderManager";

/** The snooze presets shown under a reminder card, in order. */
const SNOOZE_PRESETS: Array<{ key: string; label: string }> = [
	{ key: "10m", label: "10m" },
	{ key: "1h", label: "1h" },
	{ key: "tomorrow", label: "Tomorrow" },
];

/** How far ahead a snooze preset pushes a reminder, measured from now. */
function snoozeDelayMs(key: string): number {
	if (key === "10m") return 10 * 60_000;
	if (key === "1h") return 60 * 60_000;
	if (key === "tomorrow") {
		const date = new Date();
		date.setDate(date.getDate() + 1);
		date.setHours(9, 0, 0, 0);
		return Math.max(0, date.getTime() - Date.now());
	}
	return 0;
}

export function reminderButtons(id: string, userId: string) {
	const row = new ActionRowBuilder<ButtonBuilder>();
	for (const { key, label } of SNOOZE_PRESETS) {
		row.addComponents(
			new ButtonBuilder()
				.setCustomId(`reminder:snooze:${userId}:${id}:${key}`)
				.setLabel(label)
				.setEmoji("😴")
				.setStyle(ButtonStyle.Secondary),
		);
	}
	row.addComponents(
		new ButtonBuilder()
			.setCustomId(`reminder:delete:${userId}:${id}`)
			.setLabel("Delete")
			.setEmoji("🗑️")
			.setStyle(ButtonStyle.Danger),
	);
	return row;
}

/** The reminder confirmation card — the "Clean" layout. */
export function buildReminderCard(reminder: Reminder): EmbedBuilder {
	const timestamp = Math.floor(reminder.time.getTime() / 1000);
	return new EmbedBuilder()
		.setColor(config.reminderColor)
		.setTitle("⏰ Reminder set")
		.setDescription(reminder.message)
		.addFields(
			{ name: "When", value: `<t:${timestamp}:F>`, inline: true },
			{ name: "Fires", value: `<t:${timestamp}:R>`, inline: true },
		)
		.setFooter({ text: `RemindMe · ${reminder.id}` })
		.setTimestamp();
}

/** A channel whose name marks it as a place group reminders live. */
export function nameIsReminderChannel(name: string | null | undefined): boolean {
	return typeof name === "string" && name.toLowerCase().includes("reminder");
}

/**
 * Set a date's time-of-day from a phrase like "9am", "17:00", "5pm", "8".
 * Empty defaults to 09:00. Returns false only when the phrase was given but
 * could not be read, so a caller can reject it.
 */
function applyTimeOfDay(date: Date, phrase?: string): boolean {
	const text = (phrase || "").trim().toLowerCase();
	if (!text) {
		date.setHours(9, 0, 0, 0);
		return true;
	}
	const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
	if (!match) return false;
	let hour = Number(match[1]);
	const minute = match[2] ? Number(match[2]) : 0;
	const meridiem = match[3];
	if (meridiem === "pm" && hour < 12) hour += 12;
	if (meridiem === "am" && hour === 12) hour = 0;
	if (hour > 23 || minute > 59) return false;
	date.setHours(hour, minute, 0, 0);
	return true;
}

const WEEKDAY_PREFIXES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Read a standalone "when" phrase into a delay in ms from now, or null. Built
 * for the /remind `when` field, so no leading verb or "in" is required:
 * "30min", "2h", "1.5 hours", "3 days", "tomorrow", "tomorrow 8am",
 * "friday", "next friday 6pm", "17:00", "on 2026-08-01 09:00".
 */
export function parseWhen(input: string): number | null {
	const raw = input.trim();
	if (!raw) return null;
	const lower = raw.toLowerCase();
	const now = Date.now();

	// Relative duration, with or without a leading "in".
	const duration = lower
		.replace(/^in\s+/, "")
		.match(
			/^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?|w|wks?|weeks?)$/,
		);
	if (duration) {
		const value = Number(duration[1]);
		const unit = duration[2];
		const minutes = unit.startsWith("w")
			? 7 * 24 * 60
			: unit.startsWith("d")
				? 24 * 60
				: unit.startsWith("h")
					? 60
					: 1;
		const ms = value * minutes * 60_000;
		return ms > 0 ? ms : null;
	}

	// tomorrow [at] [time]
	const tomorrow = lower.match(/^tomorrow(?:\s+(?:at\s+)?(.+))?$/);
	if (tomorrow) {
		const date = new Date();
		date.setDate(date.getDate() + 1);
		if (!applyTimeOfDay(date, tomorrow[1])) return null;
		return date.getTime() - now;
	}

	// [on|this|next] weekday [at] [time]
	const weekday = lower.match(
		/^(?:on\s+|this\s+|next\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:\s+(?:at\s+)?(.+))?$/,
	);
	if (weekday) {
		const target = WEEKDAY_PREFIXES.indexOf(weekday[1]);
		if (target >= 0) {
			const date = new Date();
			let days = (target - date.getDay() + 7) % 7;
			if (days === 0) days = 7;
			date.setDate(date.getDate() + days);
			if (!applyTimeOfDay(date, weekday[2])) return null;
			return date.getTime() - now;
		}
	}

	// A bare time today ("17:00", "9am"), rolled to tomorrow if already past.
	const timeOnly = lower
		.replace(/^at\s+/, "")
		.match(/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/);
	if (timeOnly) {
		const date = new Date();
		if (applyTimeOfDay(date, lower.replace(/^at\s+/, ""))) {
			if (date.getTime() <= now) date.setDate(date.getDate() + 1);
			return date.getTime() - now;
		}
	}

	// An absolute date/time the platform can parse ("2026-08-01 09:00"). Guarded
	// to strings that actually look like a date — a date separator or a month
	// name — so a bare number like "45" is not read as the year 2045.
	const candidate = raw.replace(/^on\s+/i, "");
	const looksLikeDate =
		/[-/:]/.test(candidate) ||
		/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(candidate);
	if (looksLikeDate) {
		const absolute = new Date(candidate);
		if (!Number.isNaN(absolute.getTime()) && absolute.getTime() > now)
			return absolute.getTime() - now;
	}

	return null;
}

export async function reviewReminderIntent(
	input: string,
): Promise<{ text: string; delayMs: number } | null> {
	if (!config.localLlmEnabled) return null;
	try {
		const result = await askLocalLlm(
			`Decide whether this is a reminder request. Return JSON only: {"isReminder":boolean,"text":string,"delayMinutes":number}. Current time is ${new Date().toISOString()}. If it is not a reminder or has no reliable future time, use isReminder false. Request: ${input}`,
		);
		const json = JSON.parse(
			result.replace(/^```json\s*|\s*```$/g, "").trim(),
		) as {
			isReminder?: boolean;
			text?: string;
			delayMinutes?: number;
		};
		const delayMinutes = json.delayMinutes;
		if (
			json.isReminder &&
			json.text &&
			typeof delayMinutes === "number" &&
			Number.isFinite(delayMinutes) &&
			delayMinutes > 0
		) {
			return { text: json.text, delayMs: delayMinutes * 60_000 };
		}
	} catch (error) {
		console.error("Reminder intent review failed:", error);
	}
	return null;
}

/**
 * Resolve the /remind fields into a message and a delay. The `when` field is a
 * standalone time phrase, so it is parsed directly — no "in", no model. Only a
 * genuinely freeform phrase the parser cannot read ("after lunch") falls back
 * to the local model, and only if one is enabled.
 */
export async function resolveReminder(
	text: string,
	when: string,
): Promise<{ text: string; delayMs: number } | null> {
	const message = text.trim();
	const direct = parseWhen(when);
	if (direct != null && direct > 0) return { text: message, delayMs: direct };
	const viaModel = await reviewReminderIntent(`${message} ${when.trim()}`.trim());
	if (viaModel && viaModel.delayMs > 0)
		return { text: message, delayMs: viaModel.delayMs };
	return null;
}

export async function handleReminderDeleteButton(
	interaction: import("discord.js").ButtonInteraction,
	userId: string,
	id: string,
): Promise<void> {
	if (interaction.user.id !== userId) {
		await interaction.reply({
			content: "Only the reminder owner can delete it.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	if (!(await deleteReminder(id, userId))) {
		await interaction.reply({
			content: "That reminder no longer exists.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	await interaction.update({
		components: [],
		embeds: [],
		content: "🗑️ Reminder deleted.",
	});
}

export async function handleReminderSnoozeButton(
	interaction: import("discord.js").ButtonInteraction,
	userId: string,
	id: string,
	key: string,
): Promise<void> {
	if (interaction.user.id !== userId) {
		await interaction.reply({
			content: "Only the reminder owner can snooze it.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	const newTime = new Date(Date.now() + snoozeDelayMs(key));
	const updated = await rescheduleReminder(id, userId, newTime);
	if (!updated) {
		await interaction.reply({
			content: "That reminder no longer exists.",
			flags: MessageFlags.Ephemeral,
		});
		return;
	}
	// Re-render the same card in place with the new time.
	await interaction.update({
		embeds: [buildReminderCard(updated)],
		components: [reminderButtons(updated.id, updated.userId)],
	});
}
