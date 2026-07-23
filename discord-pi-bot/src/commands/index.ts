import type { Client, Interaction } from "discord.js";
import { handleReminderDeleteButton } from "./remind";
import { handleChatInputCommand, registerSlashCommands } from "./slash";

/*
 * The bot is driven by Discord slash commands only. The old message router —
 * "!" prefixes, bare mentions, and natural-language-after-a-mention all landing
 * on the same handlers — gave one action too many triggers and made a stray
 * mention look like a command. Interactions are the single, explicit surface;
 * the AI chat bridge keeps its own "!chat"/mention path in chat.ts.
 */
export function setupCommands(client: Client) {
	client.once("clientReady", () => void registerSlashCommands(client));

	client.on("interactionCreate", async (interaction: Interaction) => {
		if (interaction.isChatInputCommand()) {
			await handleChatInputCommand(interaction);
			return;
		}
		if (interaction.isButton()) {
			const parts = interaction.customId.split(":");
			if (
				parts[0] === "reminder" &&
				parts[1] === "delete" &&
				parts.length === 4
			) {
				await handleReminderDeleteButton(interaction, parts[2], parts[3]);
			}
		}
	});
}
