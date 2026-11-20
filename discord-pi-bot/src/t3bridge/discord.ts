import {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type Client,
	EmbedBuilder,
	InteractionContextType,
	MessageFlags,
	type RESTPostAPIChatInputApplicationCommandsJSONBody,
	SlashCommandBuilder,
} from "discord.js";
import { config as botConfig } from "../config";
import { T3Bridge } from "./bridge";
import { type BridgeConfig, type ChannelRoute, bridgeSetup } from "./config";
import { T3McpClient, type T3Api } from "./mcp";
import { BridgeStore } from "./store";

/*
 * `/t3` in a post of a mapped forum (default: #suggestions → Voxel Breach):
 * the bridge between Discord and T3 Code on Gabor's PC. A slash command, not
 * a mention: mentions of the owner already go to the RemindMe assistant.
 */

const ephemeral = { flags: MessageFlags.Ephemeral } as const;
const quiet = { allowedMentions: { parse: [] } } as const;

/** Typed by hand: the inferred .toJSON() type names a nested pnpm path (TS2883, see commands/slash.ts). */
export function t3CommandJson(): RESTPostAPIChatInputApplicationCommandsJSONBody {
	return new SlashCommandBuilder()
		.setName("t3")
		.setDescription("Send this forum post to T3 Code, and its answers back here.")
		.setContexts(InteractionContextType.Guild)
		.addSubcommand((sub) =>
			sub
				.setName("start")
				.setDescription("Start a plan-mode T3 thread from this post.")
				.addStringOption((option) => option.setName("note").setDescription("Extra instructions for T3 (optional).").setMaxLength(1500)),
		)
		.addSubcommand((sub) =>
			sub
				.setName("send")
				.setDescription("Send a follow-up to this post's T3 thread.")
				.addStringOption((option) => option.setName("text").setDescription("What to tell T3.").setRequired(true).setMaxLength(4000)),
		)
		.addSubcommand((sub) =>
			sub
				.setName("propose")
				.setDescription("Ask the owner to send this post (or your follow-up) to T3.")
				.addStringOption((option) => option.setName("text").setDescription("What you'd add (optional for a new post).").setMaxLength(1500)),
		)
		.addSubcommand((sub) => sub.setName("status").setDescription("What T3 is doing with this post."))
		.addSubcommand((sub) => sub.setName("stop").setDescription("Stop relaying T3 here and interrupt its run."))
		.toJSON();
}

/** The pieces of a thread the bridge reads; discord.js's ThreadChannel fits. */
interface ThreadLike {
	id: string;
	name: string;
	url: string;
	guildId: string;
	parentId: string | null;
	parent?: { name?: string | null } | null;
	fetchStarterMessage(): Promise<{ content: string; author?: { username: string } | null; member?: { displayName: string } | null; attachments?: { size: number; map<T>(fn: (attachment: { name: string }) => T): T[] } } | null>;
}

interface Located {
	thread: ThreadLike;
	route: ChannelRoute;
}

async function locate(bridge: T3Bridge, interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<Located | string> {
	const outside = "Use `/t3` inside a post of a forum T3 is set up for (like #suggestions).";
	if (!interaction.inGuild()) return outside;
	// An older post may not be in the cache.
	const channel = interaction.channel ?? (await interaction.client?.channels.fetch(interaction.channelId).catch(() => null));
	if (!channel?.isThread()) return outside;
	const route = bridge.route({ id: channel.parentId, name: channel.parent?.name }, interaction.guildId);
	if (!route) return outside;
	return { thread: channel as unknown as ThreadLike, route };
}

function nameOf(interaction: ChatInputCommandInteraction | ButtonInteraction): string {
	const member = interaction.member as { displayName?: string; nick?: string | null } | null;
	return member?.displayName || member?.nick || interaction.user.globalName || interaction.user.username;
}

/** The forum post: its title, first message and author. */
async function readPost(thread: ThreadLike): Promise<{ title: string; body: string; author: string }> {
	const starter = await thread.fetchStarterMessage().catch(() => null);
	let body = starter?.content || "";
	if (starter?.attachments?.size) body += `\n(Attached: ${starter.attachments.map((attachment) => attachment.name).join(", ")})`;
	return { title: thread.name, body, author: starter?.member?.displayName || starter?.author?.username || "unknown" };
}

async function startFrom(bridge: T3Bridge, located: Located, by: string, extra: { note?: string; proposal?: { by: string; text: string } }): Promise<string> {
	const post = await readPost(located.thread);
	return bridge.launch({
		discordThreadId: located.thread.id,
		guildId: located.thread.guildId,
		channelId: located.thread.parentId || "",
		route: located.route,
		by,
		suggestion: {
			title: post.title,
			body: post.body,
			author: post.author,
			channelName: located.thread.parent?.name || "forum",
			link: located.thread.url,
			startedBy: by,
			...(extra.note ? { note: extra.note } : {}),
			...(extra.proposal ? { proposal: extra.proposal } : {}),
		},
	});
}

export function proposalCard(input: { id: string; kind: "start" | "send"; userName: string; text: string; color: number }) {
	const what = input.kind === "start" ? "Send this post to T3 Code (plan mode, in its own worktree)." : "Send this follow-up to the post's T3 thread:";
	const quote = input.text.trim() ? `\n\n${input.text.trim().slice(0, 1500).replace(/^/gm, "> ")}` : "";
	const embed = new EmbedBuilder()
		.setColor(input.color)
		.setTitle("Proposal for T3")
		.setDescription(`${what}${quote}`)
		.addFields({ name: "Proposed by", value: input.userName.slice(0, 100) || "someone", inline: true })
		.setFooter({ text: "Only the owner can approve this." });
	const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
		new ButtonBuilder().setCustomId(`t3:approve:${input.id}`).setLabel("Approve").setStyle(ButtonStyle.Success),
		new ButtonBuilder().setCustomId(`t3:reject:${input.id}`).setLabel("Reject").setStyle(ButtonStyle.Secondary),
	);
	return { embeds: [embed], components: [row] };
}

export async function handleT3Command(bridge: T3Bridge, interaction: ChatInputCommandInteraction): Promise<void> {
	const located = await locate(bridge, interaction);
	if (typeof located === "string") {
		await interaction.reply({ content: located, ...ephemeral });
		return;
	}
	const sub = interaction.options.getSubcommand();
	const userId = interaction.user.id;
	const by = nameOf(interaction);
	const allowed = bridge.isAllowed(userId);
	const threadId = located.thread.id;

	if (sub === "status") {
		await interaction.deferReply(ephemeral);
		await interaction.editReply({ content: await bridge.status(threadId), ...quiet });
		return;
	}
	if (sub === "propose") {
		if (allowed) {
			await interaction.reply({ content: "You can do this yourself: `/t3 start` for a new post, `/t3 send` for a follow-up.", ...ephemeral });
			return;
		}
		const text = interaction.options.getString("text") || "";
		const kind = bridge.record(threadId) ? "send" : "start";
		if (kind === "send" && !text.trim()) {
			await interaction.reply({ content: "This post is already with T3. Add the follow-up you'd like to send as `text`.", ...ephemeral });
			return;
		}
		const proposal = bridge.propose({ kind, discordThreadId: threadId, userId, userName: by, text });
		if (!proposal) {
			await interaction.reply({ content: "That's all the proposals you can make today. Try again tomorrow.", ...ephemeral });
			return;
		}
		await interaction.reply({ ...proposalCard({ id: proposal.id, kind, userName: by, text, color: botConfig.reminderColor }), ...quiet });
		return;
	}
	if (!allowed) {
		await interaction.reply({ content: "Only people the owner allowed can drive T3 from here. `/t3 propose` asks the owner instead.", ...ephemeral });
		return;
	}
	// T3 can take a few seconds; Discord wants an answer within three.
	await interaction.deferReply();
	let reply: string;
	if (sub === "start") reply = await startFrom(bridge, located, by, { note: interaction.options.getString("note") || undefined });
	else if (sub === "send") reply = await bridge.send(threadId, interaction.options.getString("text", true), by);
	else if (sub === "stop") reply = await bridge.stop(threadId, by);
	else reply = "I don't know that one.";
	await interaction.editReply({ content: reply, ...quiet });
}

export async function handleT3Button(bridge: T3Bridge, interaction: ButtonInteraction): Promise<void> {
	const [, verb, arg] = interaction.customId.split(":");
	if (!bridge.isOwner(interaction.user.id)) {
		await interaction.reply({ content: "Only the owner can press this.", ...ephemeral });
		return;
	}
	const by = nameOf(interaction);
	if (verb === "build") {
		await interaction.update({ components: [] });
		await interaction.followUp({ content: await bridge.build(arg, by), ...quiet });
		return;
	}
	if (verb !== "approve" && verb !== "reject") return;
	const proposal = bridge.takeProposal(arg);
	const embed = interaction.message.embeds[0] ? EmbedBuilder.from(interaction.message.embeds[0]) : new EmbedBuilder().setTitle("Proposal for T3");
	if (!proposal) {
		await interaction.update({ components: [] });
		await interaction.followUp({ content: "That proposal was already answered or has expired.", ...ephemeral });
		return;
	}
	if (verb === "reject") {
		await interaction.update({ embeds: [embed.setFooter({ text: `Declined by ${by}.` })], components: [] });
		return;
	}
	await interaction.update({ embeds: [embed.setFooter({ text: `Approved by ${by}.` })], components: [] });
	const located = await locate(bridge, interaction);
	if (typeof located === "string" || located.thread.id !== proposal.discordThreadId) {
		await interaction.followUp({ content: "I can't find the post this proposal was for.", ...ephemeral });
		return;
	}
	const reply =
		proposal.kind === "start"
			? await startFrom(bridge, located, by, { proposal: { by: proposal.userName, text: proposal.text } })
			: await bridge.send(proposal.discordThreadId, proposal.text, by, { by: proposal.userName });
	await interaction.followUp({ content: reply, ...quiet });
}

export interface T3Discord {
	bridge: T3Bridge;
	/** Registered to this server only; blank: wherever the other commands go. */
	guildId: string;
	command: RESTPostAPIChatInputApplicationCommandsJSONBody;
	onCommand(interaction: ChatInputCommandInteraction): Promise<void>;
	onButton(interaction: ButtonInteraction): Promise<void>;
}

/** Ready-made bridge pieces from a config, for tests and for the bot. */
export function createT3Discord(input: { config: BridgeConfig; api: T3Api; store: BridgeStore; client: Pick<Client, "channels">; summarize?: (prompt: string) => Promise<string | undefined>; ready?: Promise<unknown> }): T3Discord {
	const bridge = new T3Bridge({
		config: input.config,
		api: input.api,
		store: input.store,
		summarize: input.summarize,
		poster: {
			async post(discordThreadId, message) {
				const channel = await input.client.channels.fetch(discordThreadId);
				if (!channel?.isSendable()) throw new Error("the Discord thread isn't there or I can't write in it");
				await channel.send({ content: message.content, components: message.components || [], ...quiet });
			},
		},
	});
	const ready = input.ready || Promise.resolve();
	const guard = async (work: () => Promise<void>, interaction: ChatInputCommandInteraction | ButtonInteraction) => {
		try {
			await ready;
			await work();
		} catch (error) {
			console.error("[t3] interaction failed:", error instanceof Error ? error.message : error);
			const content = "Something went wrong talking to T3.";
			if (interaction.replied || interaction.deferred) await interaction.followUp({ content, ...ephemeral }).catch(() => {});
			else await interaction.reply({ content, ...ephemeral }).catch(() => {});
		}
	};
	return {
		bridge,
		guildId: input.config.guildId,
		command: t3CommandJson(),
		onCommand: (interaction) => guard(() => handleT3Command(bridge, interaction), interaction),
		onButton: (interaction) => guard(() => handleT3Button(bridge, interaction), interaction),
	};
}

/**
 * The bridge for the running bot, or undefined when it isn't configured
 * (no t3_mcp_url or t3_token): then the bot works exactly as before.
 */
export function startT3Bridge(client: Client, summarize?: (prompt: string) => Promise<string | undefined>): T3Discord | undefined {
	const setup = bridgeSetup();
	// Read once; nothing started later (agents, the browser) should find it in the environment.
	delete process.env.T3_TOKEN;
	if (!setup.on) {
		console.log(`T3 bridge is off: ${setup.reason}.`);
		return undefined;
	}
	for (const warning of setup.warnings) console.warn(`[t3] ${warning}`);
	const { config } = setup;
	const store = new BridgeStore(config.dataPath);
	const ready = store.load();
	const t3 = createT3Discord({ config, api: new T3McpClient(config.url, config.token), store, client, summarize, ready });
	void ready.then(() => t3.bridge.start());
	console.log(`T3 bridge is on: ${config.channels.size} channel route(s), ${config.allowedUsers.length} allowed user(s), polling every ${config.pollMs / 1000} s.`);
	return t3;
}
