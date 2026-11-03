import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	MessageFlags,
	type Attachment,
	type ButtonInteraction,
	type Client,
	type Message,
} from "discord.js";
import type { ImageInput, Source } from "../ai/types";
import { embedText } from "../assistant/embeds";
import type { HomeApi } from "../agent/home";
import type { Assistant } from "../assistant/agent";
import type { ActivityLog } from "../assistant/activity";
import type { Confirmation, ConfirmationStore } from "../assistant/confirmations";
import { splitMessage, type DiscordChats } from "./chats";
import { BARE_MENTION_PROMPT, gatherContext, isPicture, mentionContext, type MentionContext } from "./context";

export interface ChatDeps {
	assistant: Assistant;
	chats: DiscordChats;
	confirmations: ConfirmationStore;
	home?: HomeApi;
	ownerId: string;
	activity?: ActivityLog;
	/** Server roles whose members may mention the bot too, for questions and fact checks. */
	guestRoles?: () => string[];
}

/** Questions a guest may ask a day, so the owner's AI budget stays theirs. */
export const GUEST_DAILY = 20;
const guestCounts = new Map<string, { day: string; count: number }>();

/** Whether a guest has a question left today; counts it if so. */
export function guestAllowed(userId: string, now = new Date()): boolean {
	const day = now.toISOString().slice(0, 10);
	const seen = guestCounts.get(userId);
	const count = seen?.day === day ? seen.count : 0;
	if (count >= GUEST_DAILY) return false;
	guestCounts.set(userId, { day, count: count + 1 });
	return true;
}

/** Whether a server member has one of the allowed roles, by name and ignoring case. */
export function hasGuestRole(memberRoles: string[], allowed: string[]): boolean {
	const wanted = new Set(allowed.map((role) => role.toLowerCase()));
	return memberRoles.some((role) => wanted.has(role.toLowerCase()));
}

/** A guest's bare mention on a message: check it. */
export const GUEST_BARE_PROMPT = "Is this true? Check it.";

const MAX_IMAGE_BYTES = 5_000_000;

/** What the owner wrote, without the bot mention (as a user or its role) or the old "!chat" prefix. */
export function promptFrom(content: string, botId?: string, roleIds: string[] = []): string {
	let text = content;
	if (botId) text = text.replace(new RegExp(`<@!?${botId}>`, "g"), "");
	for (const roleId of roleIds) text = text.replace(new RegExp(`<@&${roleId}>`, "g"), "");
	return text.trim().replace(/^!chat\b\s*/i, "").trim();
}

/** The bot's own role in a server: picking "@RemindMe" from the list can mention that instead of the bot. */
function botRoles(message: Message, botId: string | undefined): string[] {
	if (!botId || !message.inGuild()) return [];
	return [...message.mentions.roles.values()].filter((role) => role.tags?.botId === botId).map((role) => role.id);
}

/** The pages an answer cites, under it as links that don't unfold into previews. */
export function withSources(text: string, sources: Source[] = []): string {
	const listed = sources.filter((source) => /^https?:\/\//.test(source.url) && !text.includes(source.url)).slice(0, 5);
	if (!listed.length) return text;
	const label = (source: Source) => {
		const title = (source.title || "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
		const site = new URL(source.url).hostname.replace(/^www\./, "");
		return title ? `${title.length > 70 ? `${title.slice(0, 69)}…` : title} (${site})` : site;
	};
	return `${text}\n\n**Sources**\n${listed.map((source) => `- [${label(source)}](<${source.url}>)`).join("\n")}`;
}

/** What the turn was about, for the chat's history: so "move it to 10" later still knows what "it" was. */
export function aboutLine(context: MentionContext): string | undefined {
	const first = context.replied || context.forwarded?.[0] || context.recent?.[context.recent.length - 1];
	if (!first) return undefined;
	const text = first.text.replace(/\s+/g, " ").trim();
	const which = context.replied ? "the message" : context.forwarded ? "a forwarded message" : "the messages before it, the last";
	return `(about ${which} from ${first.author}: «${text.length > 160 ? `${text.slice(0, 159)}…` : text || "(no text)"}»${first.link ? ` ${first.link}` : ""})`;
}

export function isReset(prompt: string): boolean {
	return /^(new|reset|start over|new chat|forget (it|that|this))[.!]?$/i.test(prompt.trim());
}

async function readImages(attachments: Attachment[]): Promise<ImageInput[]> {
	const images: ImageInput[] = [];
	for (const attachment of attachments) {
		const type = (attachment.contentType || "").split(";")[0];
		if (!isPicture(attachment) || attachment.size > MAX_IMAGE_BYTES || images.length >= 4) continue;
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
		// Never @everyone or a role, whatever the answer quotes; only the person asking hears of the reply.
		const payload = { content: chunk, components: last ? confirmRows(confirms) : [], allowedMentions: { parse: [], repliedUser: true } };
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
	const roles = botRoles(message, botId);
	const mentioned = Boolean(botId && message.mentions.users.has(botId)) || roles.length > 0;
	if (!inDm && !mentioned) return;
	const owner = message.author.id === deps.ownerId;
	// Someone else in a server with an allowed role may ask questions and check facts; nobody else gets an answer.
	const guest =
		!owner && !inDm && message.member && hasGuestRole([...message.member.roles.cache.values()].map((role) => role.name), deps.guestRoles?.() || [])
			? { name: message.member.displayName || message.author.username }
			: undefined;
	if (!owner && !guest) {
		if (inDm) await message.reply("I'm a private assistant and only answer my owner.");
		return;
	}
	// Each guest has a conversation of their own, apart from the owner's in the same channel.
	const chatKey = guest ? `guest:${message.channelId}:${message.author.id}` : message.channelId;
	let prompt = promptFrom(message.content, botId, roles);
	if (isReset(prompt)) {
		deps.chats.reset(chatKey);
		await message.reply("Fresh start. What's up?");
		return;
	}
	if (guest && !guestAllowed(message.author.id)) {
		await message.reply({ content: `That's all the questions I can take from you today (${GUEST_DAILY}). Try again tomorrow.`, allowedMentions: { parse: [], repliedUser: true } });
		return;
	}
	// What "this" is: the message replied to or forwarded, or in a server the last few before it.
	// "(the user)" marks whoever is asking: the owner, or the guest.
	const { context, pictures } = await gatherContext(message, guest ? message.author.id : deps.ownerId, { recent: !inDm });
	const extra = mentionContext(context, undefined, { guest: Boolean(guest) });
	const own = [...message.attachments.values()].filter(isPicture);
	const images = await readImages([...own, ...pictures]);
	const about = Boolean(context.replied || context.forwarded?.length || context.recent?.length);
	if (!prompt && !images.length && !about) return;
	if (!prompt) prompt = about ? (guest ? GUEST_BARE_PROMPT : BARE_MENTION_PROMPT) : "What's in this picture?";
	const note = aboutLine(context);
	await enqueue(chatKey, async () => {
		const typing = () => {
			if (message.channel.isSendable()) void message.channel.sendTyping().catch(() => {});
		};
		typing();
		const timer = setInterval(typing, 8_000);
		try {
			const result = await deps.assistant.ask({
				prompt,
				channel: "discord",
				history: deps.chats.history(chatKey),
				conversationId: deps.chats.conversationId(chatKey),
				images,
				...(extra ? { extra } : {}),
				...(guest ? { guest } : {}),
			});
			// Discord has no cards: they follow the answer as plain lines.
			const text = withSources([result.text, ...result.embeds.map(embedText)].filter(Boolean).join("\n\n") || "Done.", result.sources);
			if (!result.problem)
				deps.chats.append(chatKey, [
					{
						role: "user",
						text: [prompt, images.length ? `(with ${images.length} image${images.length === 1 ? "" : "s"})` : "", note || ""].filter(Boolean).join(" "),
						at: new Date(message.createdTimestamp).toISOString(),
					},
					{ role: "assistant", text, at: new Date().toISOString(), ...(result.did.length ? { did: result.did.map((item) => item.text) } : {}) },
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
	deps.chats.append(interaction.channelId, [{ role: "assistant", text: `(${line})`, at: new Date().toISOString() }]);
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
 * server) is a turn. A mention reads what it's about: the message replied
 * to or forwarded, or the last few in the channel; a bare mention makes a
 * reminder of it. Actions that wait for confirmation come back as buttons.
 * Server members with an allowed role may mention it too: they get answers
 * and fact checks from the web, and nothing of the owner's.
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
