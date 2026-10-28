import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PushMessage } from "./push";

/**
 * Notifications through the Home Assistant app on the phone, which can do
 * what a web app on an iPhone can't: buttons, a reply field, a picture, and
 * Live Activities on the Lock Screen. No developer account needed: the
 * Companion app is already signed by Home Assistant.
 *
 * A tap comes back as Home Assistant's mobile_app_notification_action event
 * (see ha-events.ts) carrying the button's id: a random, one-time id that
 * stands for what the button does, kept here in memory.
 */

/** A button on a notification: what it says, and what tapping it does. */
export interface PhoneButton {
	title: string;
	/** Red: it changes something that can't be undone. */
	destructive?: boolean;
	/** Only from an unlocked phone: Face ID or the code first. */
	unlocked?: boolean;
	/** A text field instead of a plain button; what was typed goes to run. */
	reply?: { button: string; placeholder: string };
	/** A link the button opens instead, such as the shop. */
	uri?: string;
	/** Does it, and says what to show in the notification's place. */
	run?(reply?: string): Promise<string>;
}

export interface PhoneNotice extends PushMessage {
	buttons?: PhoneButton[];
	/** A picture, at an address the phone can load. */
	image?: string;
	/** No sound: a follow-up to something already shown. */
	quiet?: boolean;
}

export interface HaAppSettings {
	/** The notify service, such as mobile_app_iphone_von_gabor. Empty: switched off in Settings. */
	target?: string;
	liveActivities: boolean;
}

export interface LiveUpdate {
	title: string;
	message: string;
	progress?: { done: number; total: number };
	url?: string;
	/** The first push starts the activity with a sound; later ones are quiet. */
	first: boolean;
}

interface Pending {
	group: string;
	button: PhoneButton;
	tag: string;
	title: string;
	at: number;
}

const BUTTON_TTL = 7 * 86_400_000;
const MAX_BUTTONS = 6;
const TAG = /[^A-Za-z0-9_-]/g;

export const safeTag = (tag: string) => tag.replace(TAG, "-").slice(0, 64) || "remindme";

/**
 * Where a tap on a notification goes: RemindMe's panel in the Home Assistant
 * app (/app/<slug>), on the thread it's about. A web address would open a
 * browser instead, and iOS can't hand a link to an installed web app.
 */
export function appLink(url: string | undefined, slug: string, phoneUrl?: string): string | undefined {
	const thread = /#t\/([\w-]+)/.exec(url || "")?.[1];
	if (slug) return `/app/${slug}${thread ? `/t/${thread}` : ""}`;
	return phoneUrl ? new URL(url || "./", `${phoneUrl}/`).toString() : undefined;
}

/** A notification shows text as it is: Markdown's stars, links and headings come off. */
export function plainText(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\((?:https?:|\.\/)[^)]*\)/g, "$1")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/`([^`\n]+)`/g, "$1");
}

export class HaApp {
	private settings: HaAppSettings = { liveActivities: true };
	private readonly pending = new Map<string, Pending>();

	constructor(
		private readonly home: { callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> } | undefined,
		private readonly options: {
			path?: string;
			/** The ha_notify_target option, used until a phone is picked in Settings. */
			fallbackTarget?: string;
			/** A relative link ("./#t/abc") as an address the phone opens. */
			link(url?: string): string | undefined;
		},
	) {}

	private get path(): string {
		return this.options.path || process.env.HA_APP_DATA_PATH || "./data/ha-app.json";
	}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Partial<HaAppSettings>;
			this.settings = { liveActivities: saved.liveActivities !== false, ...(typeof saved.target === "string" ? { target: saved.target } : {}) };
		} catch {
			this.settings = { liveActivities: true };
		}
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(`${this.path}.tmp`, JSON.stringify(this.settings));
		await rename(`${this.path}.tmp`, this.path);
	}

	/** The notify service in use, or undefined when it's off. */
	get target(): string | undefined {
		const target = this.settings.target ?? this.options.fallbackTarget?.replace(/^notify\./, "");
		return this.home && target ? target : undefined;
	}

	get on(): boolean {
		return Boolean(this.target);
	}

	get liveActivities(): boolean {
		return this.on && this.settings.liveActivities;
	}

	/** The Live Activities switch itself, on or off whichever phone is picked. */
	get liveSetting(): boolean {
		return this.settings.liveActivities;
	}

	async choose(input: { target?: string; liveActivities?: boolean }): Promise<void> {
		if (input.target !== undefined) this.settings.target = input.target.replace(/^notify\./, "");
		if (input.liveActivities !== undefined) this.settings.liveActivities = input.liveActivities;
		await this.save();
	}

	private async notify(data: Record<string, unknown>): Promise<boolean> {
		const target = this.target;
		if (!target || !this.home) return false;
		try {
			await this.home.callService("notify", target, data);
			return true;
		} catch (error) {
			console.warn("The Home Assistant app notification failed:", error instanceof Error ? error.message : error);
			return false;
		}
	}

	async send(notice: PhoneNotice, now = Date.now()): Promise<boolean> {
		this.sweep(now);
		const tag = safeTag(notice.tag || `rm-${randomBytes(6).toString("hex")}`);
		const group = randomBytes(8).toString("hex");
		const actions = (notice.buttons || []).slice(0, MAX_BUTTONS).map((button) => {
			if (button.uri) return { action: "URI", title: button.title, uri: button.uri };
			const id = `REMINDME_${randomBytes(12).toString("hex")}`;
			this.pending.set(id, { group, button, tag, title: notice.title, at: now });
			return {
				action: id,
				title: button.title,
				...(button.destructive ? { destructive: true } : {}),
				...(button.unlocked ? { authenticationRequired: true } : {}),
				...(button.reply ? { behavior: "textInput", textInputButtonTitle: button.reply.button, textInputPlaceholder: button.reply.placeholder } : {}),
			};
		});
		const url = this.options.link(notice.url);
		return this.notify({
			title: notice.title,
			message: notice.body,
			data: {
				tag,
				group: "remindme",
				...(url ? { url } : {}),
				...(notice.image ? { image: notice.image } : {}),
				...(actions.length ? { actions } : {}),
				push: { ...(notice.badge !== undefined ? { badge: notice.badge } : {}), ...(notice.quiet ? { "interruption-level": "passive" } : {}) },
			},
		});
	}

	/** Start or update a Live Activity on the Lock Screen. */
	async live(tag: string, update: LiveUpdate): Promise<boolean> {
		const url = this.options.link(update.url);
		return this.notify({
			title: update.title,
			message: update.message,
			data: {
				tag: safeTag(tag),
				live_update: true,
				notification_icon: "mdi:cat",
				notification_icon_color: "#ffffff",
				background_color: "#000000",
				text_color: "#ffffff",
				progress_bar_color: "#ffffff",
				...(update.progress && update.progress.total > 0 ? { progress: update.progress.done, progress_max: update.progress.total } : {}),
				...(url ? { url } : {}),
				...(update.first ? {} : { silent: true }),
			},
		});
	}

	/** End a Live Activity, or take back a notification. */
	async clear(tag: string): Promise<boolean> {
		return this.notify({ message: "clear_notification", data: { tag: safeTag(tag) } });
	}

	/** A tap on one of RemindMe's buttons, from the mobile_app_notification_action event. */
	async tapped(event: { action?: unknown; reply_text?: unknown }, now = Date.now()): Promise<void> {
		const id = typeof event.action === "string" ? event.action : "";
		if (!id.startsWith("REMINDME_")) return;
		this.sweep(now);
		const found = this.pending.get(id);
		if (!found) {
			await this.send({ title: "RemindMe", body: "That button has expired. Open RemindMe to do it there.", quiet: true });
			return;
		}
		// One tap per notification: its other buttons go with it.
		for (const [key, entry] of this.pending) if (entry.group === found.group) this.pending.delete(key);
		const reply = typeof event.reply_text === "string" ? event.reply_text.trim().slice(0, 2_000) : undefined;
		let text: string;
		try {
			text = found.button.run ? await found.button.run(reply) : "Done.";
		} catch (error) {
			text = `That didn't work: ${error instanceof Error ? error.message : String(error)}`;
		}
		// The answer takes the notification's place, quietly.
		await this.send({ title: found.title, body: text, tag: found.tag, quiet: true });
	}

	private sweep(now: number) {
		for (const [key, entry] of this.pending) if (now - entry.at > BUTTON_TTL) this.pending.delete(key);
	}
}
