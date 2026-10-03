import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentDirectory } from "./runtime-store";

/** The owner shares the HA agent; other Discord users keep ordinary chat only. */
export async function askAgent(message: string, userId: string, channelId: string): Promise<string> {
	const { key } = JSON.parse(await readFile(join(agentDirectory(), "internal-key.json"), "utf8"));
	const response = await fetch(`http://127.0.0.1:${Number(process.env.HARNESS_PORT || 8090)}/internal/discord-chat`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ message, userId, channelId }), signal: AbortSignal.timeout(10 * 60_000) });
	const data = await response.json() as { response?: string; error?: string };
	if (!response.ok || !data.response) throw new Error(data.error || "Assistant returned no answer");
	return data.response;
}
