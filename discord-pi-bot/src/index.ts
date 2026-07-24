import "dotenv/config";
import { Client, GatewayIntentBits } from "discord.js";
import { config, validateConfig } from "./config";
import { setupCommands } from "./commands";
import { setupAIChat } from "./chat";
import { setupPiBridge } from "./piBridge";
import { startReminderScheduler } from "./utils/reminderManager";
import { startPresenceMonitor } from "./presence";
import { deliverReminder, deliveryTargets } from "./harness/reminderDelivery";

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

	// Login
	client.login(config.token);

	client.once("clientReady", async () => {
		if (client.user) {
			console.log(`Logged in as ${client.user.tag}`);
			/*
			 * One handler for every reminder, whoever created it. The
			 * !remindme command used to carry its own, which only replied in
			 * the channel — so the same reminder reached Home Assistant and
			 * the phone or did not, depending on whether the bot happened to
			 * restart before it came due.
			 */
			startReminderScheduler(async (reminder) => {
				const callHomeAssistant = async (
					service: string,
					data: Record<string, unknown>,
				) => {
					const token = process.env.SUPERVISOR_TOKEN;
					if (!token) throw new Error("Home Assistant API token unavailable");
					const response = await fetch(
						`http://supervisor/core/api/services/${service}`,
						{
							method: "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify(data),
						},
					);
					if (!response.ok)
						throw new Error(
							`Home Assistant notification failed: ${response.status}`,
						);
				};
				return deliverReminder(reminder, process.env.OWNER_ID || "", {
					homeAssistant: () =>
						callHomeAssistant("persistent_notification/create", {
							title: "RemindMe",
							message: reminder.message,
							notification_id: reminder.id,
						}),
					mobile: process.env.HA_NOTIFY_TARGET
						? () =>
								callHomeAssistant(
									`notify/${process.env.HA_NOTIFY_TARGET?.replace(/^notify\./, "")}`,
									{ title: "RemindMe", message: reminder.message },
								)
						: undefined,
					discord: async () => {
						/*
						 * A reminder made in a channel answers there and mentions
						 * whoever set it — that is how anyone (owner included) uses
						 * a #reminders channel.
						 */
						if (reminder.channelId) {
							const channel = await client.channels.fetch(reminder.channelId);
							if (!channel?.isSendable())
								throw new Error("Discord reminder channel unavailable");
							await channel.send(
								`⏰ <@${reminder.userId}>, reminder: **${reminder.message}**`,
							);
							return;
						}
						/*
						 * No channel: a private reminder, e.g. one set from the LLM
						 * console. Deliver it as a DM to its owner, so console and
						 * Discord stay in sync for the same person.
						 */
						if (!reminder.userId)
							throw new Error("Reminder has no Discord recipient");
						try {
							const user = await client.users.fetch(reminder.userId);
							await user.send(`⏰ Reminder: **${reminder.message}**`);
						} catch (error) {
							/*
							 * 50007 = "Cannot send messages to this user": they share
							 * no server with the bot or have DMs closed. Nothing here
							 * fixes that, so treat it as done rather than retrying the
							 * DM every minute for ever.
							 */
							if (
								error &&
								typeof error === "object" &&
								"code" in error &&
								(error as { code?: number }).code === 50007
							) {
								console.warn(
									`Cannot DM reminder to ${reminder.userId}; they must share a server with the bot and allow DMs.`,
								);
								return;
							}
							throw error;
						}
					},
				},
				/*
				 * Resume from what was already delivered. Without this a retry
				 * starts every channel afresh, so one unreachable Discord
				 * channel meant a fresh Home Assistant notification and phone
				 * push every minute for as long as it stayed unreachable.
				 */
				{
					...deliveryTargets(reminder, process.env.OWNER_ID || ""),
					...(reminder.deliveryStatus || {}),
				},
			);
			});
			await startPresenceMonitor(client);
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
