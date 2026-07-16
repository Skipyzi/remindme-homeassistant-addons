import { ActivityType, type Client } from "discord.js";
import { config } from "./config";

const CHECK_INTERVAL_MS = 60_000;
let bridgeUrl: URL | undefined;
if (config.webhookUrl) {
	try {
		const parsed = new URL(config.webhookUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			throw new Error("PI_AGENT_WEBHOOK_URL must use HTTP or HTTPS");
		bridgeUrl = parsed;
	} catch (error) {
		console.error("Invalid PI_AGENT_WEBHOOK_URL; presence monitoring disabled:", error);
	}
}

async function piAgentIsReachable(): Promise<boolean> {
	if (!bridgeUrl) return false;
	try {
		const response = await fetch(bridgeUrl, {
			method: "GET",
			signal: AbortSignal.timeout(5_000),
		});
		return response.ok || response.status < 500;
	} catch {
		return false;
	}
}

export async function updatePresence(client: Client): Promise<void> {
	const connected = await piAgentIsReachable();
	const status = connected ? "online" : "idle";
	const state = connected ? "Pi agent connected" : "Pi agent offline";

	client.user?.setPresence({
		status,
		activities: [
			{
				name: state,
				type: ActivityType.Watching,
				state: `${state} • !help`,
			},
		],
	});

	console.log(`Pi agent status: ${connected ? "connected" : "offline"}`);
}

export function startPresenceMonitor(client: Client): NodeJS.Timeout {
	void updatePresence(client);
	return setInterval(() => void updatePresence(client), CHECK_INTERVAL_MS);
}
