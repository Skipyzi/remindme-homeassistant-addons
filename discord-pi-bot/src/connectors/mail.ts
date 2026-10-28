import type { MailAccount } from "../mail/mailboxes";
import type { ConnectorStore, StoredConnector } from "./store";

export interface MailPreset {
	id: string;
	label: string;
	host?: string;
	port?: number;
	/** How to get a password the server accepts, in plain words. */
	help: string;
}

/*
 * Mail services that still take a password over IMAP. Outlook.com doesn't
 * (it wants Microsoft sign-in), so it isn't here.
 */
export const MAIL_PRESETS: MailPreset[] = [
	{ id: "gmail", label: "Gmail", host: "imap.gmail.com", port: 993, help: "Needs 2-step verification and an app password: Google Account, Security, App passwords. Not your normal password." },
	{ id: "gmx", label: "GMX", host: "imap.gmx.net", port: 993, help: "Turn on \"POP3/IMAP Abruf\" in GMX's mail settings first. Your GMX password, or an app password if you use 2-factor sign-in." },
	{ id: "webde", label: "WEB.DE", host: "imap.web.de", port: 993, help: "Turn on \"POP3/IMAP Abruf\" in WEB.DE's mail settings first. Your WEB.DE password, or an app password if you use 2-factor sign-in." },
	{ id: "icloud", label: "iCloud Mail", host: "imap.mail.me.com", port: 993, help: "Needs an app-specific password from account.apple.com, Sign-In and Security." },
	{ id: "imap", label: "Other mail (IMAP)", help: "Any mailbox that offers IMAP over SSL; your provider lists the server name." },
];

/** The connector kinds the console can add. Mail is the first; calendars and feeds can follow. */
export const CONNECTOR_KINDS = [
	{
		id: "mail",
		label: "Mail account",
		description: "RemindMe can search and read it, mention new mail in the brief, nudge you about bills and appointments, and save a reply in your Drafts folder when you ask. It never sends, deletes, moves or marks mail as read.",
		presets: MAIL_PRESETS,
	},
];

/** A saved mail connector as an account the mail code can open. */
export function mailAccount(connector: StoredConnector): MailAccount | undefined {
	const preset = MAIL_PRESETS.find((entry) => entry.id === connector.preset);
	const host = connector.values.host || preset?.host || "";
	const port = Number(connector.values.port || preset?.port || 993);
	const user = connector.values.address || "";
	const raw = connector.secrets.password || "";
	// Google shows app passwords in groups of four; the spaces aren't part of it.
	const pass = connector.preset === "gmail" ? raw.replace(/\s+/g, "") : raw;
	if (!host || !user || !pass || !Number.isInteger(port)) return undefined;
	return { id: connector.id, label: connector.name, host, port, user, pass, provider: host === "imap.gmail.com" ? "gmail" : "imap" };
}

/** Check what the console sent before anything is saved or tested. */
export function checkMailInput(input: { preset?: unknown; name?: unknown; values?: unknown; secrets?: unknown }, requirePassword: boolean): {
	preset: string;
	name: string;
	values: Record<string, string>;
	secrets: Record<string, string>;
} {
	const preset = MAIL_PRESETS.find((entry) => entry.id === input.preset);
	if (!preset) throw new Error("Pick a mail service.");
	const raw = (input.values && typeof input.values === "object" ? input.values : {}) as Record<string, unknown>;
	const secretsIn = (input.secrets && typeof input.secrets === "object" ? input.secrets : {}) as Record<string, unknown>;
	const address = String(raw.address || "").trim();
	if (!/^[^\s@]+@[^\s@]+$/.test(address) && preset.id !== "imap") throw new Error("Enter the full email address.");
	if (!address) throw new Error("Enter the account's user name or address.");
	const values: Record<string, string> = { address };
	if (preset.id === "imap") {
		const host = String(raw.host || "").trim();
		if (!/^[a-z0-9.-]+$/i.test(host)) throw new Error("Enter the IMAP server name, such as imap.example.com.");
		const port = Number(raw.port || 993);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("The port is a number, usually 993.");
		values.host = host;
		values.port = String(port);
	}
	const password = String(secretsIn.password || "");
	if (requirePassword && !password) throw new Error("Enter the password.");
	const name = String(input.name || "").trim().slice(0, 40) || preset.label;
	return { preset: preset.id, name, values, secrets: password ? { password } : {} };
}

/**
 * Gmail and GMX set in the app options (4.2) become connectors, once. If the
 * password in the options changes later, the imported connector follows it.
 */
export async function importMailOptions(store: ConnectorStore, env: NodeJS.ProcessEnv = process.env): Promise<void> {
	const fromOptions = [
		{ preset: "gmail", address: env.GMAIL_ADDRESS, password: env.GMAIL_APP_PASSWORD },
		{ preset: "gmx", address: env.GMX_ADDRESS, password: env.GMX_PASSWORD },
	];
	for (const entry of fromOptions) {
		const address = (entry.address || "").trim();
		if (!address || !entry.password) continue;
		const existing = store.list("mail").find((connector) => connector.values.address?.toLowerCase() === address.toLowerCase());
		if (!existing) {
			const preset = MAIL_PRESETS.find((item) => item.id === entry.preset)!;
			await store.create({ kind: "mail", preset: entry.preset, name: preset.label, enabled: true, values: { address }, secrets: { password: entry.password }, fromOptions: true });
		} else if (existing.fromOptions && existing.secrets.password !== entry.password) await store.update(existing.id, { secrets: { password: entry.password } });
	}
}
