import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "discord.js";

/**
 * The bot goes by the assistant's name and wears its cat, as set in the
 * console under Settings → Your assistant. Discord lets a bot rename itself
 * about twice an hour, so a change waits a moment for the next one and a
 * refused rename falls back to a nickname in each server until it's taken.
 */

export interface Identity {
	/** "mochi", or RemindMe. */
	name(): string;
	/** Which cat: its coat and what it wears. */
	seed(): string;
	/** The cat as a square PNG for the avatar. */
	avatar(): Promise<Buffer>;
	/** Called when the name or the cat changes. */
	onChange(listener: () => void): void;
}

interface Applied {
	/** The cat last made the avatar. */
	seed?: string;
	/** Servers where the bot carries the name as a nickname, because the rename was refused. */
	nicknamed?: string[];
}

const SETTLE_MS = 20_000;
const RETRY_MS = 30 * 60_000;

/** A name Discord takes for a bot: 2 to 32 characters, without the words and marks it refuses. */
export function discordName(name: string, fallback = "RemindMe"): string {
	const cleaned = name
		.replace(/discord|```/gi, "")
		.replace(/[@#:]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 32)
		.trim();
	return cleaned.length >= 2 && !/^(everyone|here)$/i.test(cleaned) ? cleaned : fallback;
}

export class IdentitySync {
	private timer?: NodeJS.Timeout;
	private running = Promise.resolve();

	constructor(
		private readonly client: Client,
		private readonly identity: Identity,
		private readonly path = process.env.DISCORD_IDENTITY_PATH || "./data/discord-identity.json",
		private readonly settleMs = SETTLE_MS,
	) {}

	start(): void {
		this.client.once("clientReady", () => this.schedule(0));
		this.client.on("guildCreate", () => this.schedule());
		this.identity.onChange(() => this.schedule());
	}

	/** Sync once things have settled: picking a coat often means trying a few. */
	schedule(delay = this.settleMs): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.running = this.running.then(() => this.sync()).catch((error) => console.warn("Couldn't update the Discord bot's name or picture:", error instanceof Error ? error.message : error));
		}, delay);
		this.timer.unref?.();
	}

	async sync(): Promise<void> {
		const user = this.client.user;
		if (!user) return;
		const applied = await this.load();
		const name = discordName(this.identity.name());
		let retry = false;

		let renamed = user.username === name;
		if (!renamed) {
			try {
				await user.setUsername(name);
				renamed = true;
				console.log(`The Discord bot is called ${name} now.`);
			} catch (error) {
				retry = true;
				console.warn(`Discord didn't take the name ${name} yet (${error instanceof Error ? error.message : error}); it goes by it as a nickname in each server meanwhile.`);
			}
		}

		// Renamed: the nicknames it put on come off. Not yet: each server shows the name as its nickname.
		const nicknamed = new Set(applied.nicknamed || []);
		for (const guild of this.client.guilds.cache.values()) {
			try {
				const me = guild.members.me || (await guild.members.fetchMe());
				if (renamed && nicknamed.has(guild.id)) {
					if (me.nickname) await me.setNickname(null, "Goes by its own name again");
					nicknamed.delete(guild.id);
				} else if (!renamed && me.displayName !== name) {
					await me.setNickname(name, "The assistant's name in RemindMe");
					nicknamed.add(guild.id);
				}
			} catch (error) {
				console.warn(`Couldn't set the bot's nickname on ${guild.name}:`, error instanceof Error ? error.message : error);
			}
		}

		const seed = this.identity.seed();
		let avatarSeed = applied.seed;
		if (applied.seed !== seed) {
			try {
				await user.setAvatar(await this.identity.avatar());
				avatarSeed = seed;
				console.log("The Discord bot wears the assistant's cat now.");
			} catch (error) {
				retry = true;
				console.warn("Discord didn't take the new picture yet:", error instanceof Error ? error.message : error);
			}
		}

		await this.save({ ...(avatarSeed ? { seed: avatarSeed } : {}), nicknamed: [...nicknamed] });
		if (retry) this.schedule(RETRY_MS);
	}

	private async load(): Promise<Applied> {
		try {
			return JSON.parse(await readFile(this.path, "utf8")) as Applied;
		} catch {
			return {};
		}
	}

	private async save(applied: Applied): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(this.path, JSON.stringify(applied));
	}
}
