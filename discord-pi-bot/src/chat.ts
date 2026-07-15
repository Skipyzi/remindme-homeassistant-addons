import type { Client, Message } from "discord.js";
import { config } from "./config";
import { askLocalLlm } from "./localLlm";

function splitDiscordMessage(text: string): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < text.length; index += 1900) {
		chunks.push(text.slice(index, index + 1900));
	}
	return chunks.length ? chunks : ["(empty response)"];
}

export function setupAIChat(client: Client): void {
	client.on("messageCreate", async (message: Message) => {
		if (message.author.bot) return;
		let content = message.content.trim();
		const botId = client.user?.id;
		const mentioned = botId ? message.mentions.has(botId) : false;
		if (mentioned && botId) {
			content = content
				.split(`<@${botId}>`)
				.join("")
				.split(`<@!${botId}>`)
				.join("")
				.trim();
		}

		const piPrefix = "!:";
		const prefix = content.startsWith(piPrefix)
			? piPrefix
			: content.startsWith(config.chatPrefix)
				? config.chatPrefix
				: null;
		if (!prefix) return;
		const prompt = content.slice(prefix.length).trim();
		if (!prompt) return;

		const thinkingMessage = await message.reply("🧠 Thinking…");
		try {
			const response =
				prefix === config.chatPrefix && config.localLlmEnabled
					? await askLocalLlm(prompt)
					: await forwardToPiAgent(prompt, message);
			const chunks = splitDiscordMessage(response);
			await thinkingMessage.edit(chunks[0]);
			for (const chunk of chunks.slice(1)) {
				await message.reply(chunk);
			}
		} catch (error) {
			console.error("Pi agent bridge error:", error);
			await thinkingMessage.edit(
				"❌ The pi-agent bridge is unavailable right now.",
			);
		}
	});
}

async function forwardToPiAgent(
	prompt: string,
	message: Message,
): Promise<string> {
	const response = await fetch(config.webhookUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			message: prompt,
			userId: message.author.id,
			username: message.author.tag,
			channelId: message.channel.id,
			guildId: message.guildId,
			timestamp: new Date().toISOString(),
		}),
	});
	if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`);
	const data: unknown = await response.json();
	if (typeof data === "string") return data;
	if (data && typeof data === "object") {
		const result = data as {
			response?: unknown;
			message?: unknown;
			content?: unknown;
		};
		const text = result.response ?? result.message ?? result.content;
		if (typeof text === "string") return text;
	}
	throw new Error("Bridge returned no response text");
}
