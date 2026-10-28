import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import webpush, { type PushSubscription } from "web-push";

export interface PushMessage {
	title: string;
	body: string;
	/** Where a tap opens the app, relative to it: "./#t/<thread>". */
	url?: string;
	/** A newer notification with the same tag replaces the older one. */
	tag?: string;
}

interface Device {
	endpoint: string;
	keys: { p256dh: string; auth: string };
	addedAt: string;
	/** "iPhone", "Android": a hint for the console's list. */
	kind?: string;
}

interface Saved {
	publicKey: string;
	privateKey: string;
	devices: Device[];
}

type Sender = (subscription: PushSubscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;

function kindOf(agent: string): string {
	if (/iPhone|iPad/i.test(agent)) return "iPhone";
	if (/Android/i.test(agent)) return "Android";
	if (/Mac OS X/i.test(agent)) return "Mac";
	if (/Windows/i.test(agent)) return "Windows";
	return "Browser";
}

/**
 * Notifications to the phone app, through the browser's own push service
 * (Apple's or Google's). The signing keys are made once and kept on the Pi;
 * a device that unsubscribed or was reset is dropped the first time its
 * push service says it's gone.
 */
export class PhonePush {
	private saved: Saved = { publicKey: "", privateKey: "", devices: [] };

	constructor(
		private readonly path = process.env.PUSH_DATA_PATH || "./data/push.json",
		/** Who sends: the app's own address, which Apple and Google require. */
		private readonly subject: () => string = () => "mailto:remindme@example.com",
		private readonly sender: Sender = webpush.sendNotification,
	) {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Partial<Saved>;
			if (saved.publicKey && saved.privateKey) this.saved = { publicKey: saved.publicKey, privateKey: saved.privateKey, devices: Array.isArray(saved.devices) ? saved.devices : [] };
		} catch {
			// First start: keys are made below.
		}
		if (!this.saved.publicKey) {
			const keys = webpush.generateVAPIDKeys();
			this.saved = { publicKey: keys.publicKey, privateKey: keys.privateKey, devices: [] };
			await this.save();
		}
	}

	get publicKey(): string {
		return this.saved.publicKey;
	}

	devices(): Array<Pick<Device, "addedAt" | "kind">> {
		return this.saved.devices.map(({ addedAt, kind }) => ({ addedAt, kind }));
	}

	async subscribe(input: unknown, agent = ""): Promise<void> {
		const subscription = input as Partial<Device> | undefined;
		const endpoint = typeof subscription?.endpoint === "string" ? subscription.endpoint : "";
		const keys = subscription?.keys;
		if (!/^https:\/\//.test(endpoint) || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") throw new Error("That isn't a push subscription.");
		this.saved.devices = [...this.saved.devices.filter((device) => device.endpoint !== endpoint), { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, addedAt: new Date().toISOString(), kind: kindOf(agent) }];
		await this.save();
	}

	async unsubscribe(endpoint?: string): Promise<void> {
		this.saved.devices = endpoint ? this.saved.devices.filter((device) => device.endpoint !== endpoint) : [];
		await this.save();
	}

	/** To every device; answers how many took it. */
	async send(message: PushMessage): Promise<number> {
		if (!this.saved.devices.length) return 0;
		const body = message.body.replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim();
		const payload = JSON.stringify({ title: message.title, body: body.length > 240 ? `${body.slice(0, 239)}…` : body, url: message.url || "./", tag: message.tag });
		let reached = 0;
		const gone: string[] = [];
		await Promise.all(
			this.saved.devices.map(async (device) => {
				try {
					await this.sender({ endpoint: device.endpoint, keys: device.keys }, payload, {
						TTL: 6 * 3600,
						urgency: "high",
						vapidDetails: { subject: this.subject(), publicKey: this.saved.publicKey, privateKey: this.saved.privateKey },
					});
					reached++;
				} catch (error) {
					const status = (error as { statusCode?: number }).statusCode;
					if (status === 404 || status === 410) gone.push(device.endpoint);
					else console.warn("A push notification failed:", status || (error instanceof Error ? error.message : error));
				}
			}),
		);
		if (gone.length) {
			this.saved.devices = this.saved.devices.filter((device) => !gone.includes(device.endpoint));
			await this.save();
		}
		return reached;
	}

	private async save(): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(`${this.path}.tmp`, JSON.stringify(this.saved), { mode: 0o600 });
		await rename(`${this.path}.tmp`, this.path);
		await chmod(this.path, 0o600).catch(() => {});
	}
}
