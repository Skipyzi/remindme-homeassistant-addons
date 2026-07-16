import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { config, validateConfig } from "./config";
import { setupCommands } from "./commands";
import { setupAIChat } from "./chat";
import { setupPiBridge } from "./piBridge";
import { loadReminders, startPeriodicCleanup } from "./utils/reminderManager";
import { startPresenceMonitor } from "./presence";

async function main() {
	// Validate configuration
	const errors = validateConfig();
	if (errors.length > 0) {
		console.error("Configuration errors:");
		errors.forEach((error) => console.error(`  - ${error}`));
		process.exit(1);
	}

	console.log("Starting Discord bot...");

	// Create client
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages,
		],
	});

	// Set up commands
	setupCommands(client);

	// Set up AI chat (pi agent bridge)
	setupAIChat(client);

	// Set up pi agent bridge
	setupPiBridge();

	// Start periodic cleanup
	startPeriodicCleanup();

	// Login
	client.login(config.token);

	client.once("clientReady", async () => {
		if (client.user) {
			console.log(`Logged in as ${client.user.tag}`);
			await loadReminders(async (reminder) => {
				const channel = await client.channels.fetch(reminder.channelId);
				if (channel?.isSendable()) {
					await channel.send(
						`⏰ <@${reminder.userId}>, reminder: **${reminder.message}**`,
					);
				}
			});
			startPresenceMonitor(client);
		}
	});

	client.on("error", (error: Error) => {
		console.error("Client error:", error);
	});
}

main().catch((error: Error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
