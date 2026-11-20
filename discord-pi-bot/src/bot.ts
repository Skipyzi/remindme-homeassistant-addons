import { Client, GatewayIntentBits, Partials } from "discord.js";
import { config, validateConfig } from "./config";
import { setupCommands } from "./commands";
import { startPresenceMonitor } from "./presence";
import { setupAssistantChat, type ChatDeps } from "./discord/assistantChat";
import { OwnerMessenger } from "./discord/messenger";
import { IdentitySync, type Identity } from "./discord/identity";
import { startT3Bridge } from "./t3bridge/discord";

/**
 * The Discord side: slash commands and the assistant in DMs. Returns the
 * messenger that brief, nudges and reminders use when Discord is wanted, or
 * undefined when no bot token is set (everything else works without it).
 */
export function startBot(deps: ChatDeps & { identity?: Identity }): OwnerMessenger | undefined {
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

	// Discord → T3 Code (src/t3bridge): off unless t3_mcp_url and t3_token are set.
	// Long answers are shortened by the assistant without tools, on its cheapest model.
	const t3 = startT3Bridge(client, (prompt) => deps.assistant.quick(prompt, undefined, { cheap: true }));
	setupCommands(client, t3);
	setupAssistantChat(client, deps);
	// The bot goes by the assistant's name and wears its cat.
	if (deps.identity) new IdentitySync(client, deps.identity).start();
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
