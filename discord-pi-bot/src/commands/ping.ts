import type { Message } from "discord.js";

export async function handlePingCommand(message: Message) {
	const start = Date.now();
	const reply = await message.reply("Pinging...");
	const latency = Date.now() - start;
	await reply.edit(`Pong! 🏓 Latency: ${latency}ms`);
}
