import {
	type ChatInputCommandInteraction,
	type Client,
	EmbedBuilder,
	MessageFlags,
	SlashCommandBuilder,
	version as discordJsVersion,
} from "discord.js";
import {
	addReminder,
	deleteReminder,
	listReminders,
} from "../utils/reminderManager";
import {
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
export const slashCommands = [
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
				.setDescription('When, e.g. "in 2 hours", "tomorrow", "on friday".')
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

/** Register the slash commands with Discord. Global, so they work everywhere. */
export async function registerSlashCommands(client: Client): Promise<void> {
	if (!client.application) return;
	try {
		await client.application.commands.set(slashCommands);
		console.log(`Registered ${slashCommands.length} slash commands.`);
	} catch (error) {
		console.error("Failed to register slash commands:", error);
	}
}

const ephemeral = { flags: MessageFlags.Ephemeral } as const;

async function runRemind(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
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
		await interaction.reply({
			content:
				"In a server, set reminders in a channel with **reminder** in its name — or DM me for a private one.",
			...ephemeral,
		});
		return;
	}

	const parsed = await resolveReminder(text, when);
	if (!parsed) {
		await interaction.reply({
			content:
				'I could not read a time from that. Try "in 30 minutes", "tomorrow", or "on 2026-08-01".',
			...ephemeral,
		});
		return;
	}

	const reminder = await addReminder(
		parsed.text,
		parsed.delayMs / 60_000,
		interaction.user.id,
		// Private (DM or a non-reminder channel) reminders carry no channel.
		inGuild ? interaction.channelId : "",
	);
	const timestamp = Math.floor(reminder.time.getTime() / 1000);
	const card = new EmbedBuilder()
		.setColor(0x5865f2)
		.setTitle("⏰ Reminder set")
		.setDescription(`**${reminder.message}**`)
		.addFields(
			{
				name: "When",
				value: `<t:${timestamp}:F>\n<t:${timestamp}:R>`,
				inline: true,
			},
			{ name: "ID", value: `\`${reminder.id}\``, inline: true },
		);
	await interaction.reply({
		embeds: [card],
		components: [reminderButtons(reminder.id, reminder.userId)],
		...ephemeral,
	});
}

async function runReminders(
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	const sub = interaction.options.getSubcommand();
	if (sub === "delete") {
		const id = interaction.options.getString("id", true);
		await interaction.reply({
			content: (await deleteReminder(id, interaction.user.id))
				? "✅ Reminder deleted."
				: "❌ No reminder with that ID that you own.",
			...ephemeral,
		});
		return;
	}
	const reminders = await listReminders(interaction.user.id);
	if (!reminders.length) {
		await interaction.reply({
			content: "You have no active reminders. Set one with `/remind`.",
			...ephemeral,
		});
		return;
	}
	const lines = reminders.map(
		(reminder) =>
			`• \`${reminder.id}\` — ${reminder.message} (<t:${Math.floor(reminder.time.getTime() / 1000)}:R>)`,
	);
	await interaction.reply({
		content: `**Your reminders**\n${lines.join("\n")}`,
		...ephemeral,
	});
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
