import { EmbedBuilder, type Client } from "discord.js";
import { config } from "../config";
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
			this.chats.append(dm.id, [{ role: "assistant", text: options.title ? `${options.title}\n${text}` : text }]);
			return true;
		} catch (error) {
			console.warn("Could not DM the owner:", error instanceof Error ? error.message : error);
			return false;
		}
	}
}
