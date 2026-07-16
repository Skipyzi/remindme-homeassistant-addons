import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { config, validateConfig } from "./config";
import { setupCommands } from "./commands";
import { setupAIChat } from "./chat";
import { setupPiBridge } from "./piBridge";
import { loadReminders, startPeriodicCleanup } from "./utils/reminderManager";
import { startPresenceMonitor } from "./presence";
import { deliverReminder } from "./harness/reminderDelivery";

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
				const callHomeAssistant = async (service: string, data: Record<string, unknown>) => {
					const token = process.env.SUPERVISOR_TOKEN;
					if (!token) throw new Error("Home Assistant API token unavailable");
					const response = await fetch(`http://supervisor/core/api/services/${service}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(data) });
					if (!response.ok) throw new Error(`Home Assistant notification failed: ${response.status}`);
				};
				return deliverReminder(reminder, process.env.OWNER_ID || "", {
					homeAssistant: () => callHomeAssistant("persistent_notification/create", { title: "RemindMe", message: reminder.message, notification_id: reminder.id }),
					mobile: process.env.HA_NOTIFY_TARGET ? () => callHomeAssistant(`notify/${process.env.HA_NOTIFY_TARGET?.replace(/^notify\./, "")}`, { title: "RemindMe", message: reminder.message }) : undefined,
					discord: async () => {
						const channel = await client.channels.fetch(reminder.channelId);
						if (!channel?.isSendable()) throw new Error("Discord reminder channel unavailable");
						await channel.send(`⏰ <@${reminder.userId}>, reminder: **${reminder.message}**`);
					},
				});
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
