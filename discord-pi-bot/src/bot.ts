import { Client, GatewayIntentBits, Partials } from "discord.js";
import { config, validateConfig } from "./config";
import { setupCommands } from "./commands";
import { startPresenceMonitor } from "./presence";
import { setupAssistantChat, type ChatDeps } from "./discord/assistantChat";
import { OwnerMessenger } from "./discord/messenger";

/**
 * The Discord side: slash commands and the assistant in DMs. Returns the
 * messenger that brief, nudges and reminders use when Discord is wanted, or
 * undefined when no bot token is set (everything else works without it).
 */
export function startBot(deps: ChatDeps): OwnerMessenger | undefined {
	const errors = validateConfig();
	if (errors.length > 0) {
		console.warn(`Discord is off: ${errors.join("; ")}. The console still works.`);
		return undefined;
	}

	console.log("Starting Discord bot...");

	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
			GatewayIntentBits.DirectMessages,
		],
		// DMs arrive on channels the bot has not cached; without this they are dropped.
		partials: [Partials.Channel, Partials.Message],
	});

	setupCommands(client);
	setupAssistantChat(client, deps);
	const messenger = new OwnerMessenger(client, config.ownerId, deps.chats);

	client.login(config.token).catch((error) => console.error("Discord login failed:", error));

	client.once("clientReady", async () => {
		if (client.user) {
			console.log(`Logged in as ${client.user.tag}`);
			await startPresenceMonitor(client);
		}
	});

	client.on("error", (error: Error) => {
		console.error("Client error:", error);
	});
	return messenger;
}
