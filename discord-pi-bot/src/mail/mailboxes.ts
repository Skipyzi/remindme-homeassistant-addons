import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export type AccountId = string;

export interface MailAccount {
	/** The connector's id. */
	id: AccountId;
	/** The connector's name, such as "Gmail" or "GMX work". */
	label: string;
	host: string;
	port: number;
	user: string;
	pass: string;
	/** Gmail searches all its mail with its own search words; others search the inbox. */
	provider: "gmail" | "imap";
}

/** One message as a line in a list: enough to judge it, not the whole thing. */
export interface MailSummary {
	/** `account|mailbox|uid`: what read_mail takes. */
	id: string;
	account: AccountId;
	date: string;
	from: string;
	subject: string;
	snippet: string;
	unread: boolean;
	/** Sent to a list: a List-Unsubscribe or bulk header. */
	bulk: boolean;
}

export interface MailMessage extends MailSummary {
	to: string;
	text: string;
	attachments: string[];
}

/** Where the messages come from: IMAP in the app, a stand-in in tests. */
export interface MailSource {
	/** Connect and count the inbox: "Connected: 1,234 messages in the inbox." */
	test(account: MailAccount): Promise<string>;
	search(account: MailAccount, query: string, since: Date, limit: number): Promise<MailSummary[]>;
	recent(account: MailAccount, since: Date, limit: number): Promise<MailSummary[]>;
	read(account: MailAccount, mailbox: string, uid: number): Promise<MailMessage | undefined>;
}

function clip(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

const SNIPPET_BYTES = 24_000;
const MESSAGE_BYTES = 1_500_000;

/**
 * IMAP, read-only: it opens mailboxes for reading and never sets flags, so
 * reading a message here doesn't mark it read on your phone.
 */
export class ImapSource implements MailSource {
	private async open<T>(account: MailAccount, work: (client: ImapFlow) => Promise<T>): Promise<T> {
		const client = new ImapFlow({
			host: account.host,
			port: account.port,
			secure: true,
			auth: { user: account.user, pass: account.pass },
			logger: false,
			disableAutoIdle: true,
		});
		try {
			await client.connect();
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new Error(`${account.label} refused the connection (${reason}). Check the address, password and server under Settings, Connectors.`);
		}
		try {
			return await work(client);
		} finally {
			await client.logout().catch(() => client.close());
		}
	}

	async test(account: MailAccount): Promise<string> {
		return this.open(account, async (client) => {
			const lock = await client.getMailboxLock("INBOX", { readOnly: true });
			try {
				const count = client.mailbox ? client.mailbox.exists : 0;
				return `Connected: ${count.toLocaleString("en-GB")} message${count === 1 ? "" : "s"} in the inbox.`;
			} finally {
				lock.release();
			}
		});
	}

	/* Gmail keeps archived mail out of the inbox, so search all of it there. */
	private async searchBox(client: ImapFlow, account: MailAccount): Promise<string> {
		if (account.provider !== "gmail") return "INBOX";
		const all = (await client.list()).find((box) => box.specialUse === "\\All");
		return all?.path || "INBOX";
	}

	private async summaries(client: ImapFlow, account: MailAccount, mailbox: string, uids: number[]): Promise<MailSummary[]> {
		if (!uids.length) return [];
		const messages = await client.fetchAll(
			uids,
			{ uid: true, envelope: true, flags: true, internalDate: true, headers: ["list-unsubscribe", "precedence", "list-id"], source: { maxLength: SNIPPET_BYTES } },
			{ uid: true },
		);
		const out: MailSummary[] = [];
		for (const message of messages) {
			const envelope = message.envelope;
			const sender = envelope?.from?.[0];
			const headers = message.headers?.toString("utf8").toLowerCase() || "";
			let snippet = "";
			if (message.source) {
				try {
					snippet = clip((await simpleParser(message.source)).text || "", 400);
				} catch {
					snippet = "";
				}
			}
			out.push({
				id: `${account.id}|${mailbox}|${message.uid}`,
				account: account.id,
				date: new Date(message.internalDate || envelope?.date || Date.now()).toISOString(),
				from: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address || "") : "",
				subject: envelope?.subject || "(no subject)",
				snippet,
				unread: !message.flags?.has("\\Seen"),
				bulk: /list-unsubscribe|precedence:\s*(bulk|list)|list-id/.test(headers),
			});
		}
		return out;
	}

	async search(account: MailAccount, query: string, since: Date, limit: number): Promise<MailSummary[]> {
		return this.open(account, async (client) => {
			const mailbox = await this.searchBox(client, account);
			const lock = await client.getMailboxLock(mailbox, { readOnly: true });
			try {
				const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000));
				const words = query.trim();
				const found =
					account.provider === "gmail"
						? await client.search({ gmraw: `${words} newer_than:${days}d`.trim() }, { uid: true })
						: await client.search(words ? { since, or: [{ subject: words }, { from: words }, { body: words }] } : { since }, { uid: true });
				const uids = (found || []).slice(-limit);
				return this.summaries(client, account, mailbox, uids);
			} finally {
				lock.release();
			}
		});
	}

	async recent(account: MailAccount, since: Date, limit: number): Promise<MailSummary[]> {
		return this.open(account, async (client) => {
			const lock = await client.getMailboxLock("INBOX", { readOnly: true });
			try {
				// SINCE counts whole days; the exact cut comes from the arrival time below.
				const found = await client.search({ since }, { uid: true });
				const uids = (found || []).slice(-limit);
				return (await this.summaries(client, account, "INBOX", uids)).filter((mail) => Date.parse(mail.date) > since.getTime());
			} finally {
				lock.release();
			}
		});
	}

	async read(account: MailAccount, mailbox: string, uid: number): Promise<MailMessage | undefined> {
		return this.open(account, async (client) => {
			const lock = await client.getMailboxLock(mailbox, { readOnly: true });
			try {
				const message = await client.fetchOne(String(uid), { uid: true, envelope: true, flags: true, internalDate: true, source: { maxLength: MESSAGE_BYTES } }, { uid: true });
				if (!message || !message.source) return undefined;
				const parsed = await simpleParser(message.source);
				const sender = message.envelope?.from?.[0];
				return {
					id: `${account.id}|${mailbox}|${uid}`,
					account: account.id,
					date: new Date(message.internalDate || parsed.date || Date.now()).toISOString(),
					from: sender ? (sender.name ? `${sender.name} <${sender.address}>` : sender.address || "") : parsed.from?.text || "",
					to: (Array.isArray(parsed.to) ? parsed.to.map((entry) => entry.text).join(", ") : parsed.to?.text) || "",
					subject: message.envelope?.subject || parsed.subject || "(no subject)",
					snippet: clip(parsed.text || "", 400),
					text: (parsed.text || "").trim().slice(0, 12_000),
					attachments: parsed.attachments.map((attachment) => attachment.filename || attachment.contentType),
					unread: !message.flags?.has("\\Seen"),
					bulk: parsed.headers.has("list-unsubscribe") || parsed.headers.has("list-id"),
				};
			} finally {
				lock.release();
			}
		});
	}
}

export interface AccountStatus {
	at: string;
	ok: boolean;
	error?: string;
}

/**
 * Every connected mail account together: what the assistant's tools and the
 * mail watcher use. The accounts are read fresh each time, so connectors
 * added or switched off in the console apply at once.
 */
export class Mailboxes {
	private readonly statuses = new Map<string, AccountStatus>();

	constructor(
		private readonly current: MailAccount[] | (() => MailAccount[]),
		private readonly source: MailSource = new ImapSource(),
	) {}

	get accounts(): MailAccount[] {
		return typeof this.current === "function" ? this.current() : this.current;
	}

	get configured(): boolean {
		return this.accounts.length > 0;
	}

	/** The last time an account was reached, and whether it worked. */
	status(id: string): AccountStatus | undefined {
		return this.statuses.get(id);
	}

	/* Every call goes through here, so the console can show each account's last check. */
	private async tracked<T>(account: MailAccount, work: () => Promise<T>): Promise<T> {
		try {
			const result = await work();
			this.statuses.set(account.id, { at: new Date().toISOString(), ok: true });
			return result;
		} catch (error) {
			this.statuses.set(account.id, { at: new Date().toISOString(), ok: false, error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	async test(account: MailAccount): Promise<string> {
		return this.tracked(account, () => this.source.test(account));
	}

	/** A connector tested before it had its id: its result, under the id it got. */
	carryStatus(from: string, to: string): void {
		const status = this.statuses.get(from);
		if (status) this.statuses.set(to, status);
		this.statuses.delete(from);
	}

	private pick(account?: string): MailAccount[] {
		if (!account) return this.accounts;
		const match = this.accounts.filter((entry) => entry.id === account.toLowerCase() || entry.label.toLowerCase() === account.toLowerCase());
		if (!match.length) throw new Error(`No mailbox called ${account}. Set up: ${this.accounts.map((entry) => entry.label).join(", ") || "none"}.`);
		return match;
	}

	/** Newest first, across the chosen accounts. A failing account is reported, not fatal. */
	async search(query: string, options: { account?: string; days?: number; limit?: number } = {}): Promise<{ mails: MailSummary[]; problems: string[] }> {
		const since = new Date(Date.now() - (options.days ?? 30) * 86_400_000);
		const limit = options.limit ?? 10;
		const problems: string[] = [];
		const lists = await Promise.all(
			this.pick(options.account).map((account) =>
				this.tracked(account, () => this.source.search(account, query, since, limit)).catch((error) => {
					problems.push(error instanceof Error ? error.message : String(error));
					return [] as MailSummary[];
				}),
			),
		);
		return { mails: lists.flat().sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit), problems };
	}

	async recent(since: Date, limit = 40): Promise<{ mails: MailSummary[]; problems: string[] }> {
		const problems: string[] = [];
		const lists = await Promise.all(
			this.accounts.map((account) =>
				this.tracked(account, () => this.source.recent(account, since, limit)).catch((error) => {
					problems.push(error instanceof Error ? error.message : String(error));
					return [] as MailSummary[];
				}),
			),
		);
		return { mails: lists.flat().sort((a, b) => a.date.localeCompare(b.date)), problems };
	}

	async read(id: string): Promise<MailMessage | undefined> {
		const [accountId, ...rest] = id.split("|");
		const uid = Number(rest.pop());
		const mailbox = rest.join("|");
		const account = this.accounts.find((entry) => entry.id === accountId);
		if (!account || !mailbox || !Number.isInteger(uid) || uid <= 0) throw new Error("That isn't a mail id from search_mail.");
		return this.tracked(account, () => this.source.read(account, mailbox, uid));
	}
}
