import { EmbedBuilder, type Client } from "discord.js";
import { config } from "../config";
import type { Reminder } from "../utils/reminderManager";
import { splitMessage, type DiscordChats } from "./chats";

/**
 * Messages the assistant sends first (the brief, nudges) go to the owner's
 * DMs and join that chat's history, so replying to one carries on from it.
 */
export class OwnerMessenger {
	constructor(
		private readonly client: Client,
		private readonly ownerId: string,
		private readonly chats: DiscordChats,
	) {}

	/** "RemindMe#6955", once logged in. */
	who(): string | undefined {
		return this.client.user?.tag;
	}

	/**
	 * A reminder that's due. One made in a channel answers there and
	 * mentions whoever set it; a private one (from the console or the AI)
	 * comes as a DM card to its owner.
	 */
	async reminder(reminder: Reminder): Promise<void> {
		if (!this.client.isReady()) throw new Error("Discord isn't connected yet");
		if (reminder.channelId) {
			const channel = await this.client.channels.fetch(reminder.channelId);
			if (!channel?.isSendable()) throw new Error("Discord reminder channel unavailable");
			await channel.send(`⏰ <@${reminder.userId}>, reminder: **${reminder.message}**`);
			return;
		}
		if (!reminder.userId) throw new Error("Reminder has no Discord recipient");
		try {
			const user = await this.client.users.fetch(reminder.userId);
			await user.send({ embeds: [new EmbedBuilder().setColor(config.reminderColor).setDescription(`⏰ **${reminder.message}**`)] });
		} catch (error) {
			/*
			 * 50007 = "Cannot send messages to this user": they share no server
			 * with the bot or have DMs closed. Nothing here fixes that, so treat
			 * it as done rather than retrying the DM every minute for ever.
			 */
			if (error && typeof error === "object" && "code" in error && (error as { code?: number }).code === 50007) {
				console.warn(`Cannot DM reminder to ${reminder.userId}; they must share a server with the bot and allow DMs.`);
				return;
			}
			throw error;
		}
	}

	/*
	 * As a card: Discord draws it on a solid panel, so it stays readable over
	 * a chat wallpaper, with the colour bar from the reminder card option.
	 */
	async send(text: string, options: { title?: string } = {}): Promise<boolean> {
		if (!this.ownerId || !this.client.isReady()) return false;
		try {
			const user = await this.client.users.fetch(this.ownerId);
			const dm = await user.createDM();
			for (const [index, chunk] of splitMessage(text, 3_900).entries()) {
				const card = new EmbedBuilder().setColor(config.reminderColor).setDescription(chunk);
				if (index === 0 && options.title) card.setTitle(options.title);
				await dm.send({ embeds: [card] });
			}
			this.chats.append(dm.id, [{ role: "assistant", text: options.title ? `${options.title}\n${text}` : text, at: new Date().toISOString() }]);
			return true;
		} catch (error) {
			console.warn("Could not DM the owner:", error instanceof Error ? error.message : error);
			return false;
		}
	}
}
