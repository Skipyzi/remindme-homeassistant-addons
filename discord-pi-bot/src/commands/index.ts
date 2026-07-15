import type { Message, Client } from "discord.js";
import {
	handleRemindCommand,
	handleRemindList,
	handleRemindDelete,
	handleReminderDeleteButton,
} from "./remind";
import { handlePingCommand } from "./ping";
import { handleHelpCommand } from "./help";
import { handleInfoCommand } from "./info";

export function setupCommands(client: Client) {
	client.on("interactionCreate", async (interaction) => {
		if (!interaction.isButton()) return;
		const parts = interaction.customId.split(":");
		if (
			parts[0] === "reminder" &&
			parts[1] === "delete" &&
			parts.length === 4
		) {
			await handleReminderDeleteButton(interaction, parts[2], parts[3]);
		}
	});

	client.on("messageCreate", async (message: Message) => {
		// Log ALL messages
		console.log(
			`\n═══════════════════════════════════════════════════════════`,
		);
		console.log(`📨 NEW MESSAGE RECEIVED`);
		console.log(`   Author: ${message.author.tag} (ID: ${message.author.id})`);
		console.log(`   Content: ${message.content}`);
		console.log(`   Channel ID: ${message.channel.id}`);
		console.log(`   Channel Type: ${message.channel.type}`);
		console.log(`   Is bot: ${message.author.bot}`);
		console.log(`   Guild: ${message.guild?.name || "DM"}`);
		console.log(`   Timestamp: ${message.createdAt}`);

		// Skip bot messages
		if (message.author.bot) {
			console.log("   → Skipping bot message\n");
			return;
		}

		// Log if message is a command
		const isCommand = message.content.startsWith("!");
		const isMention = message.mentions.has(client.user?.id || "");
		console.log(`   Is command: ${isCommand}`);
		console.log(`   Is mention: ${isMention}`);

		if (!isCommand && !isMention) {
			console.log("   → Regular message, ignoring\n");
			return;
		}

		console.log("   → Processing as command...\n");

		// Remove bot mention from content if present
		let content = message.content;
		if (isMention && client.user?.id) {
			content = content
				.split(`<@${client.user.id}>`)
				.join("")
				.split(`<@!${client.user.id}>`)
				.join("")
				.trim();
			console.log(`   Cleaned content: ${content}`);
		}

		// A bare mention is a reminder unless it is a built-in command.
		// Examples: "@Bot coffee in 30 min" and "@Bot remind me to call mom in 2 hours".
		if (isMention && !content.startsWith("!")) {
			const bareCommand = /^(ping|help|info)$/i.test(content);
			if (!bareCommand) {
				console.log("   → Handling natural-language reminder");
				await handleRemindCommand(message, `!remindme ${content}`);
				return;
			}
			content = `!${content}`;
		}

		// Handle commands
		if (content.startsWith("!remind")) {
			console.log("   → Handling remind command");
			if (content === "!remind") {
				console.log("   → Sub-command: list");
				handleRemindList(message);
			} else if (content.startsWith("!remind delete")) {
				console.log("   → Sub-command: delete");
				handleRemindDelete(message);
			} else {
				console.log("   → Sub-command: set reminder");
				handleRemindCommand(message);
			}
		}

		if (content === "!ping") {
			console.log("   → Handling ping command");
			try {
				await handlePingCommand(message);
			} catch (error) {
				console.error("Failed to send ping response:", error);
			}
		}

		if (content === "!help") {
			console.log("   → Handling help command");
			handleHelpCommand(message);
		}

		if (content === "!info") {
			console.log("   → Handling info command");
			handleInfoCommand(message);
		}

		console.log("   → Command processed\n");
	});
}
