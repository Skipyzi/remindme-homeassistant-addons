import type { PhoneNotice } from "../phone/ha-app";
import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	type ButtonInteraction,
	type Client,
	type Message,
} from "discord.js";
import type { ImageInput } from "../ai/types";
import { embedText } from "../assistant/embeds";
import type { HomeApi } from "../agent/home";
import type { Assistant } from "../assistant/agent";
import type { ActivityLog } from "../assistant/activity";
import type { Confirmation, ConfirmationStore } from "../assistant/confirmations";
import { splitMessage, type DiscordChats } from "./chats";

export interface ChatDeps {
	assistant: Assistant;
	chats: DiscordChats;
	confirmations: ConfirmationStore;
	home?: HomeApi;
	ownerId: string;
	activity?: ActivityLog;
	/** The phone app's notifications, for reminders. */
	phone?: { devices(): number; send(message: PhoneNotice): Promise<number> };
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 5_000_000;

/** What the owner wrote, without the bot mention or the old "!chat" prefix. */
export function promptFrom(content: string, botId?: string): string {
	let text = content;
	if (botId) text = text.replace(new RegExp(`<@!?${botId}>`, "g"), "");
	return text.trim().replace(/^!chat\b\s*/i, "").trim();
}

export function isReset(prompt: string): boolean {
	return /^(new|reset|start over|new chat|forget (it|that|this))[.!]?$/i.test(prompt.trim());
}

async function readImages(message: Message): Promise<ImageInput[]> {
	const images: ImageInput[] = [];
	for (const attachment of message.attachments.values()) {
		const type = (attachment.contentType || "").split(";")[0];
		if (!IMAGE_TYPES.has(type) || attachment.size > MAX_IMAGE_BYTES || images.length >= 4) continue;
		try {
			const response = await fetch(attachment.url, { signal: AbortSignal.timeout(15_000) });
			if (!response.ok) continue;
			images.push({
				mediaType: type as ImageInput["mediaType"],
				data: Buffer.from(await response.arrayBuffer()).toString("base64"),
			});
		} catch (error) {
			console.warn("Could not fetch a Discord image:", error instanceof Error ? error.message : error);
		}
	}
	return images;
}

/** One row per action that waits for a tap: confirm it, or cancel it. */
export function confirmRows(confirms: Confirmation[]): ActionRowBuilder<ButtonBuilder>[] {
	return confirms.slice(0, 5).map((confirmation) =>
		new ActionRowBuilder<ButtonBuilder>().addComponents(
			new ButtonBuilder()
				.setCustomId(`assistant:ok:${confirmation.token}`)
				.setLabel(confirmation.message.slice(0, 80))
				.setStyle(confirmation.destructive ? ButtonStyle.Danger : ButtonStyle.Primary),
			new ButtonBuilder().setCustomId(`assistant:no:${confirmation.token}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
		),
	);
}

async function reply(message: Message, text: string, confirms: Confirmation[]): Promise<void> {
	const chunks = splitMessage(text);
	for (const [index, chunk] of chunks.entries()) {
		const last = index === chunks.length - 1;
		const payload = { content: chunk, components: last ? confirmRows(confirms) : [] };
		if (index === 0) await message.reply(payload);
		else if (message.channel.isSendable()) await message.channel.send(payload);
	}
}

/*
 * One turn at a time per chat: a second message sent while the first is
 * still being answered waits, so it sees the first answer in its history.
 */
const queues = new Map<string, Promise<void>>();
function enqueue(channelId: string, work: () => Promise<void>): Promise<void> {
	const next = (queues.get(channelId) || Promise.resolve()).then(work, work);
	queues.set(channelId, next);
	void next.finally(() => {
		if (queues.get(channelId) === next) queues.delete(channelId);
	});
	return next;
}

async function handleMessage(client: Client, deps: ChatDeps, message: Message): Promise<void> {
	if (message.author.bot) return;
	const botId = client.user?.id;
	const inDm = !message.inGuild();
	const mentioned = Boolean(botId && message.mentions.users.has(botId));
	if (!inDm && !mentioned) return;
	if (message.author.id !== deps.ownerId) {
		if (inDm) await message.reply("I'm a private assistant and only answer my owner.");
		return;
	}
	let prompt = promptFrom(message.content, botId);
	if (isReset(prompt)) {
		deps.chats.reset(message.channelId);
		await message.reply("Fresh start. What's up?");
		return;
	}
	const images = await readImages(message);
	if (!prompt && !images.length) return;
	if (!prompt) prompt = "What's in this picture?";
	await enqueue(message.channelId, async () => {
		const typing = () => {
			if (message.channel.isSendable()) void message.channel.sendTyping().catch(() => {});
		};
		typing();
		const timer = setInterval(typing, 8_000);
		try {
			const result = await deps.assistant.ask({
				prompt,
				channel: "discord",
				history: deps.chats.history(message.channelId),
				conversationId: deps.chats.conversationId(message.channelId),
				images,
			});
			// Discord has no cards: they follow the answer as plain lines.
			const text = [result.text, ...result.embeds.map(embedText)].filter(Boolean).join("\n\n") || "Done.";
			if (!result.problem)
				deps.chats.append(message.channelId, [
					{ role: "user", text: images.length ? `${prompt} (with ${images.length} image${images.length === 1 ? "" : "s"})` : prompt },
					{ role: "assistant", text },
				]);
			await reply(message, text, result.confirms);
		} catch (error) {
			console.error("Discord turn failed:", error);
			await message.reply("Something went wrong on my side. Try again in a moment.").catch(() => {});
		} finally {
			clearInterval(timer);
		}
	});
}

async function handleButton(deps: ChatDeps, interaction: ButtonInteraction): Promise<void> {
	const [, verb, token] = interaction.customId.split(":");
	if (interaction.user.id !== deps.ownerId) {
		await interaction.reply({ content: "Only my owner can confirm this.", flags: MessageFlags.Ephemeral });
		return;
	}
	let line: string;
	if (verb === "no") {
		const pending = deps.confirmations.list().find((item) => item.token === token);
		deps.confirmations.cancel(token);
		deps.activity?.resolve(token, "cancelled", pending?.message || "Cancelled");
		line = "Cancelled.";
	} else {
		const held = deps.confirmations.take(token);
		if (!held) line = "That request expired. Ask me again.";
		else {
			try {
				await held.perform();
				deps.activity?.resolve(token, "confirmed", held.label);
				line = `Done: ${held.label}.`;
			} catch (error) {
				const reason = error instanceof Error ? error.message : "That didn't work";
				deps.activity?.resolve(token, "failed", `${held.label}: ${reason}`);
				line = `${held.label} failed: ${reason}.`;
			}
		}
	}
	deps.chats.append(interaction.channelId, [{ role: "assistant", text: `(${line})` }]);
	// Keep the other actions' buttons; drop the one just answered.
	const remaining = interaction.message.components
		.map((row) => row.toJSON())
		.filter((row) => !JSON.stringify(row).includes(token));
	await interaction.update({
		content: `${interaction.message.content}\n${line}`.slice(0, 2000),
		components: remaining as never,
	});
}

/**
 * The assistant on Discord: every DM from the owner (and a mention in a
 * server) is a turn. Actions that wait for confirmation come back as buttons.
 */
export function setupAssistantChat(client: Client, deps: ChatDeps): void {
	client.on("messageCreate", (message) => {
		void handleMessage(client, deps, message).catch((error) => console.error("Discord message failed:", error));
	});
	client.on("interactionCreate", (interaction) => {
		if (!interaction.isButton() || !interaction.customId.startsWith("assistant:")) return;
		void handleButton(deps, interaction).catch((error) => console.error("Confirm button failed:", error));
	});
}
