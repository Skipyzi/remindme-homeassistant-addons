import type { Client } from "discord.js";
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

	async send(text: string): Promise<boolean> {
		if (!this.ownerId || !this.client.isReady()) return false;
		try {
			const user = await this.client.users.fetch(this.ownerId);
			const dm = await user.createDM();
			for (const chunk of splitMessage(text)) await dm.send(chunk);
			this.chats.append(dm.id, [{ role: "assistant", text }]);
			return true;
		} catch (error) {
			console.warn("Could not DM the owner:", error instanceof Error ? error.message : error);
			return false;
		}
	}
}
