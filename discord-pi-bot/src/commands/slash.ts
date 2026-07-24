import {
	type ChatInputCommandInteraction,
	type Client,
	MessageFlags,
	SlashCommandBuilder,
	version as discordJsVersion,
} from "discord.js";
import { config } from "../config";
import {
	addReminder,
	deleteReminder,
	listReminders,
} from "../utils/reminderManager";
import {
	buildReminderCard,
	nameIsReminderChannel,
	reminderButtons,
	resolveReminder,
} from "./remind";

/*
 * Discord slash commands are the only way to drive the bot. They replace the
 * old tangle of "!" prefixes, bare mentions, and natural-language-after-mention,
 * which all reached the same handlers and made it unclear what counted as a
 * command. These are registered with Discord once the client is ready.
 */
/*
 * Not exported: the type of a SlashCommandBuilder's .toJSON() names a
 * discord-api-types symbol from a nested (pnpm) path, which cannot be written
 * portably into a .d.ts under `declaration: true` (TS2883). Keeping this
 * module-private avoids emitting its type at all; it is only used here.
 */
const slashCommands = [
	new SlashCommandBuilder()
		.setName("remind")
		.setDescription("Set a reminder.")
		.addStringOption((option) =>
			option
				.setName("text")
				.setDescription("What to be reminded about.")
				.setRequired(true),
		)
		.addStringOption((option) =>
			option
				.setName("when")
				.setDescription(
					'When: "30min", "2h", "tomorrow", "friday 6pm", "2026-08-01 09:00".',
				)
				.setRequired(true),
		),
	new SlashCommandBuilder()
		.setName("reminders")
		.setDescription("View or remove your reminders.")
		.addSubcommand((sub) =>
			sub.setName("list").setDescription("List your active reminders."),
		)
		.addSubcommand((sub) =>
			sub
				.setName("delete")
				.setDescription("Delete one of your reminders.")
				.addStringOption((option) =>
					option
						.setName("id")
						.setDescription("The reminder ID, from /reminders list.")
						.setRequired(true),
				),
		),
	new SlashCommandBuilder().setName("ping").setDescription("Check bot latency."),
	new SlashCommandBuilder().setName("help").setDescription("How to use the bot."),
	new SlashCommandBuilder()
		.setName("info")
		.setDescription("Bot status and runtime information."),
].map((command) => command.toJSON());

/**
 * Register the slash commands with Discord.
 *
 * With a guild id set they are registered to that one server, where they
 * appear immediately — the right choice for a personal bot. Without it they
 * register globally, which works everywhere but can take up to an hour to
 * show the first time.
 */
export async function registerSlashCommands(client: Client): Promise<void> {
	if (!client.application) return;
	try {
		if (config.guildId) {
			await client.application.commands.set(slashCommands, config.guildId);
			console.log(
				`Registered ${slashCommands.length} slash commands to guild ${config.guildId}.`,
			);
		} else {
			await client.application.commands.set(slashCommands);
			console.log(
				`Registered ${slashCommands.length} slash commands globally (up to ~1h to appear).`,
			);
		}
	} catch (error) {
		console.error("Failed to register slash commands:", error);
	}
}

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

/*
 * Placeholder text shown for the instant the ack sits before the real result
 * edits in. With playful_placeholders on (the default) it is a random surreal
 * line — the bot "pondering your choices" is funnier than "is thinking…";
 * off falls back to a plain, literal message.
 */
const REMIND_ACKS = [
	"⏰ Pondering your choices…",
	"⏰ Consulting the void…",
	"⏰ Aligning the cosmic timers…",
	"⏰ Negotiating with tomorrow…",
	"⏰ Bribing a nearby clock…",
	"⏰ Waking the reminder gnomes…",
	"⏰ Folding time into a neat little note…",
	"⏰ Teaching a goldfish to remember for you…",
	"⏰ Asking the moon to keep an eye on it…",
];
const LIST_ACKS = [
	"📋 Rifling through the archive…",
	"📋 Summoning your past intentions…",
	"📋 Dusting off the ledger…",
	"📋 Interrogating the gnomes about what you forgot…",
	"📋 Unrolling the scroll of things-to-do…",
];

function ack(pool: string[], plain: string): string {
	if (!config.playfulPlaceholders) return plain;
	return pool[Math.floor(Math.random() * pool.length)];
}

async function runRemind(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	/*
	 * Acknowledge first with a real message, not deferReply — its placeholder
	 * is Discord's "is thinking…", which reads oddly for a reminder. Parsing
	 * the time can call the local model and the store write touches a locked
	 * file; either can outrun Discord's 3-second window and kill the token
	 * (10062). Replying now acks in time and the result edits this message.
	 */
	await interaction.reply({
		content: ack(REMIND_ACKS, "⏰ Setting your reminder…"),
		...ephemeral,
	});
	const text = interaction.options.getString("text", true);
	const when = interaction.options.getString("when", true);
	/*
	 * In a server, reminders belong in a #reminder(s) channel so the due ping
	 * lands where the group is watching. A reminder run from anywhere else, or
	 * from a DM, is private: it has no channel and comes back as a DM.
	 */
	const channel = interaction.channel;
	const channelName =
		channel && "name" in channel ? (channel.name as string | null) : null;
	const inGuild = interaction.inGuild();
	if (inGuild && !nameIsReminderChannel(channelName)) {
		await interaction.editReply(
			"In a server, set reminders in a channel with **reminder** in its name — or DM me for a private one.",
		);
		return;
	}

	const parsed = await resolveReminder(text, when);
	if (!parsed) {
		await interaction.editReply(
			'I could not read a time from that. Try "in 30 minutes", "tomorrow", or "on 2026-08-01".',
		);
		return;
	}

	const reminder = await addReminder(
		parsed.text,
		parsed.delayMs / 60_000,
		interaction.user.id,
		// Private (DM or a non-reminder channel) reminders carry no channel.
		inGuild ? interaction.channelId : "",
	);
	await interaction.editReply({
		embeds: [buildReminderCard(reminder)],
		components: [reminderButtons(reminder.id, reminder.userId)],
	});
}

async function runReminders(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	// Ack first with a real message (not the "is thinking…" defer): the shared
	// store is read/written under a lock, which can outrun the 3-second window
	// on a busy Pi (10062). The result edits this message.
	await interaction.reply({
		content: ack(LIST_ACKS, "📋 One moment…"),
		...ephemeral,
	});
	const sub = interaction.options.getSubcommand();
	if (sub === "delete") {
		const id = interaction.options.getString("id", true);
		await interaction.editReply(
			(await deleteReminder(id, interaction.user.id))
				? "✅ Reminder deleted."
				: "❌ No reminder with that ID that you own.",
		);
		return;
	}
	const reminders = await listReminders(interaction.user.id);
	if (!reminders.length) {
		await interaction.editReply(
			"You have no active reminders. Set one with `/remind`.",
		);
		return;
	}
	const lines = reminders.map(
		(reminder) =>
			`• \`${reminder.id}\` — ${reminder.message} (<t:${Math.floor(reminder.time.getTime() / 1000)}:R>)`,
	);
	await interaction.editReply(`**Your reminders**\n${lines.join("\n")}`);
}

async function runPing(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	await interaction.reply({ content: "Pinging…", ...ephemeral });
	const latency = Date.now() - interaction.createdTimestamp;
	const ws = Math.round(interaction.client.ws.ping);
	await interaction.editReply(
		`Pong! 🏓 Round-trip ${latency}ms${ws >= 0 ? ` · WS ${ws}ms` : ""}`,
	);
}

function runHelp(interaction: ChatInputCommandInteraction): Promise<unknown> {
	return interaction.reply({
		content: `🤖 **RemindMe commands**

**/remind** \`text\` \`when\` — set a reminder (in a server, use a channel with *reminder* in its name; or DM me for a private one)
**/reminders list** — your active reminders
**/reminders delete** \`id\` — remove one
**/ping** — check latency
**/info** — bot status

Talk to the AI assistant with the \`${"!chat"}\` prefix or by mentioning me.`,
		...ephemeral,
	});
}

function runInfo(interaction: ChatInputCommandInteraction): Promise<unknown> {
	const uptime = process.uptime();
	const days = Math.floor(uptime / 86400);
	const hours = Math.floor((uptime % 86400) / 3600);
	const minutes = Math.floor((uptime % 3600) / 60);
	return interaction.reply({
		content: `📊 **Bot Information**

• **Uptime:** ${days}d ${hours}h ${minutes}m
• **JavaScript Runtime:** ${process.version}
• **Platform:** ${process.platform}
• **Heap Used:** ${Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10} MB
• **Discord.js:** ${discordJsVersion}`,
		...ephemeral,
	});
}

/** Route a slash command interaction to its handler. */
export async function handleChatInputCommand(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	try {
		switch (interaction.commandName) {
			case "remind":
				return await runRemind(interaction);
			case "reminders":
				return await runReminders(interaction);
			case "ping":
				return void (await runPing(interaction));
			case "help":
				return void (await runHelp(interaction));
			case "info":
				return void (await runInfo(interaction));
		}
	} catch (error) {
		console.error(`Slash command /${interaction.commandName} failed:`, error);
		const message = "Something went wrong running that command.";
		if (interaction.replied || interaction.deferred)
			await interaction.followUp({ content: message, ...ephemeral }).catch(() => {});
		else await interaction.reply({ content: message, ...ephemeral }).catch(() => {});
	}
}
