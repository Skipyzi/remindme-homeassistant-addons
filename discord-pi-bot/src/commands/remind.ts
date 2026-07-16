import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	type Message,
} from "discord.js";
import { askLocalLlm } from "../localLlm";
import { config } from "../config";
import {
	deleteReminder,
	getReminders,
	setReminder,
	type Reminder,
} from "../utils/reminderManager";

function reminderButtons(id: string, userId: string) {
	return new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder()
			.setCustomId(`reminder:delete:${userId}:${id}`)
			.setLabel("Delete")
			.setEmoji("🗑️")
			.setStyle(ButtonStyle.Danger),
	);
}

function channelIsForReminders(message: Message): boolean {
	const name =
		"name" in message.channel && typeof message.channel.name === "string"
			? message.channel.name
			: "";
	return name.toLowerCase().includes("reminders");
}

function parseTime(input: string): { text: string; delayMs: number } | null {
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

async function reviewReminderIntent(
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

function commandText(content: string): string {
	return content.replace(/^!(?:remindme|remind)(?:\s+me)?\s*/i, "").trim();
}

export async function handleRemindCommand(
	message: Message,
	input?: string,
): Promise<void> {
	if (!channelIsForReminders(message)) {
		await message.reply(
			"⚠️ Reminders only work in a channel with **reminders** in its name.",
		);
		return;
	}
	const reminderInput = commandText(input ?? message.content);
	const parsed =
		parseTime(reminderInput) ?? (await reviewReminderIntent(reminderInput));
	if (!parsed || parsed.delayMs <= 0) {
		await message.reply(
			"Usage: `!remindme <thing> in <number> minutes/hours/days/weeks` or `!remindme <thing> on <date>`.",
		);
		return;
	}

	const reminder = setReminder(
		parsed.text,
		parsed.delayMs / 60_000,
		message.author.id,
		message.channel.id,
		async (due: Reminder): Promise<void> => {
			await message.reply(`⏰ <@${due.userId}>, reminder: **${due.message}**`);
		},
	);
	const timestamp = Math.floor(reminder.time.getTime() / 1000);
	const card = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("⏰ Reminder created")
		.setDescription(`**${reminder.message}**`)
		.addFields(
			{
				name: "When",
				value: `<t:${timestamp}:F>\n<t:${timestamp}:R>`,
				inline: true,
			},
			{ name: "Reminder ID", value: `\`${reminder.id}\``, inline: true },
			{ name: "Owner", value: `<@${reminder.userId}>`, inline: true },
		)
		.setFooter({ text: "Use !remindme edit/delete <id>" });
	await message.reply({
		embeds: [card],
		components: [reminderButtons(reminder.id, reminder.userId)],
	});
}

export async function handleRemindList(message: Message): Promise<void> {
	if (!channelIsForReminders(message)) {
		await message.reply(
			"⚠️ Reminders only work in a channel with **reminders** in its name.",
		);
		return;
	}
	const reminders = getReminders(message.author.id);
	if (!reminders.length) {
		await message.reply("You have no active reminders.");
		return;
	}
	const lines = reminders.map(
		(reminder) =>
			`• \`${reminder.id}\` — ${reminder.message} (<t:${Math.floor(reminder.time.getTime() / 1000)}:R>)`,
	);
	await message.reply(`**Your reminders**\n${lines.join("\n")}`);
}

export async function handleReminderDeleteButton(
	interaction: import("discord.js").ButtonInteraction,
	userId: string,
	id: string,
): Promise<void> {
	if (interaction.user.id !== userId) {
		await interaction.reply({
			content: "Only the reminder owner can delete it.",
			ephemeral: true,
		});
		return;
	}
	if (!deleteReminder(id, userId)) {
		await interaction.reply({
			content: "That reminder no longer exists.",
			ephemeral: true,
		});
		return;
	}
	await interaction.update({
		components: [],
		content: "🗑️ Reminder deleted.",
	});
}

export async function handleRemindDelete(message: Message): Promise<void> {
	const id = message.content
		.replace(/^!(?:remindme|remind)\s+delete\s*/i, "")
		.trim();
	await message.reply(
		deleteReminder(id, message.author.id)
			? "✅ Reminder deleted."
			: "❌ Reminder not found.",
	);
}
