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

export function parseTime(
	input: string,
): { text: string; delayMs: number } | null {
	const tomorrowMatch = input.match(/^(.+?)\s+tomorrow\s*$/i);
	if (tomorrowMatch) {
		const date = new Date();
		date.setDate(date.getDate() + 1);
		date.setHours(9, 0, 0, 0);
		return {
			text: tomorrowMatch[1].trim(),
			delayMs: date.getTime() - Date.now(),
		};
	}

	const weekdayMatch = input.match(
		/^(.+?)\s+(?:on|this|next)\s+(mon(?:day)?|tues?day|wednes?day|thur(?:s|st)day|fri(?:day)?|satur?day|sun(?:day)?)\s*$/i,
	);
	if (weekdayMatch) {
		const names = [
			"sunday",
			"monday",
			"tuesday",
			"wednesday",
			"thursday",
			"friday",
			"saturday",
		];
		const normalized = weekdayMatch[2]
			.toLowerCase()
			.replace("thurstday", "thursday");
		const dayName = normalized.startsWith("thu") ? "thursday" : normalized;
		const target = names.findIndex((name) =>
			dayName.startsWith(name.slice(0, 3)),
		);
		if (target >= 0) {
			const now = new Date();
			const date = new Date(now);
			let days = (target - now.getDay() + 7) % 7;
			if (days === 0) days = 7;
			date.setDate(now.getDate() + days);
			date.setHours(9, 0, 0, 0);
			return {
				text: weekdayMatch[1].trim(),
				delayMs: date.getTime() - Date.now(),
			};
		}
	}

	const relative = input.match(
		/^(.+?)\s+in\s+(\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\s*$/i,
	);
	if (relative) {
		const value = Number(relative[2]);
		const unit = relative[3].toLowerCase();
		const multiplier = unit.startsWith("week")
			? 7 * 24 * 60 * 60_000
			: unit.startsWith("day")
				? 24 * 60 * 60_000
				: unit.startsWith("hour") || unit.startsWith("hr")
					? 60 * 60_000
					: 60_000;
		return { text: relative[1].trim(), delayMs: value * multiplier };
	}

	const dateMatch = input.match(/^(.+?)\s+(?:on|at)\s+(.+)$/i);
	if (dateMatch) {
		const date = new Date(dateMatch[2]);
		if (!Number.isNaN(date.getTime()) && date.getTime() > Date.now()) {
			return {
				text: dateMatch[1].trim(),
				delayMs: date.getTime() - Date.now(),
			};
		}
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
 * Resolve a reminder's "what" and "when" into text and a delay, trying the
 * fast pattern parser first and the local model as a fallback. `when` is the
 * user's time phrase, e.g. "in 2 hours", "tomorrow", "on friday".
 */
export async function resolveReminder(
	text: string,
	when: string,
): Promise<{ text: string; delayMs: number } | null> {
	const combined = `${text.trim()} ${when.trim()}`.trim();
	const parsed = parseTime(combined) ?? (await reviewReminderIntent(combined));
	if (!parsed || parsed.delayMs <= 0) return null;
	return parsed;
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
