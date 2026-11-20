import type { Client, Interaction } from "discord.js";
import {
	handleReminderDeleteButton,
	handleReminderSnoozeButton,
} from "./remind";
import { handleChatInputCommand, registerSlashCommands } from "./slash";
import type { T3Discord } from "../t3bridge/discord";

/*
 * The bot is driven by Discord slash commands only. The old message router —
 * "!" prefixes, bare mentions, and natural-language-after-a-mention all landing
 * on the same handlers — gave one action too many triggers and made a stray
 * mention look like a command. Interactions are the single, explicit surface;
 * the assistant itself answers DMs and mentions (discord/assistantChat.ts).
 */
export function setupCommands(client: Client, t3?: T3Discord) {
	client.once("clientReady", () => void registerSlashCommands(client, t3 ? { guildId: t3.guildId, commands: [t3.command] } : undefined));

	client.on("interactionCreate", async (interaction: Interaction) => {
		if (interaction.isChatInputCommand()) {
			// The T3 Code bridge (src/t3bridge), only when it's configured.
			if (interaction.commandName === "t3") {
				if (t3) await t3.onCommand(interaction);
				return;
			}
			await handleChatInputCommand(interaction);
			return;
		}
		if (interaction.isButton()) {
			if (interaction.customId.startsWith("t3:")) {
				if (t3) await t3.onButton(interaction);
				return;
			}
			const parts = interaction.customId.split(":");
			if (parts[0] !== "reminder") return;
			if (parts[1] === "delete" && parts.length === 4) {
				await handleReminderDeleteButton(interaction, parts[2], parts[3]);
			} else if (parts[1] === "snooze" && parts.length === 5) {
				await handleReminderSnoozeButton(
					interaction,
					parts[2],
					parts[3],
					parts[4],
				);
			}
		}
	});
}
