import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { simpleParser } from "mailparser";
import { Mailboxes, recipients, refusal, type MailAccount, type MailMessage, type MailSource, type MailSummary } from "../src/mail/mailboxes.ts";
import { ConnectorStore, publicView } from "../src/connectors/store.ts";
import { checkMailInput, importMailOptions, mailAccount } from "../src/connectors/mail.ts";
import { statSync } from "node:fs";
import { MailWatch, findingText, parseFindings, sortMail, worthKnowing } from "../src/mail/watch.ts";
import { ConfirmationStore } from "../src/assistant/confirmations.ts";
import { buildTools, newEffects, runTool } from "../src/assistant/tools.ts";

const mail = (account: "gmail" | "gmx", uid: number, values: Partial<MailSummary> = {}): MailSummary => ({
	id: `${account}|INBOX|${uid}`,
	account,
	date: new Date(Date.UTC(2026, 9, 28, 8, uid)).toISOString(),
	from: "someone@example.com",
	subject: `Mail ${uid}`,
	snippet: "Hello",
	unread: true,
	bulk: false,
	...values,
});

class FakeSource implements MailSource {
	calls: string[] = [];
	async test(account: MailAccount) {
		if (this.failing.has(account.id)) throw new Error(`${account.label} refused the connection`);
		return "Connected: 3 messages in the inbox.";
	}
	inbox: MailSummary[] = [];
	failing = new Set<string>();
	async search(account: MailAccount, query: string, _since: Date, limit: number) {
		this.calls.push(`search ${account.id} ${query}`);
		if (this.failing.has(account.id)) throw new Error(`${account.label} refused the connection`);
		return this.inbox.filter((item) => item.account === account.id && item.subject.toLowerCase().includes(query.toLowerCase())).slice(-limit);
	}
	async recent(account: MailAccount, since: Date) {
		this.calls.push(`recent ${account.id}`);
		if (this.failing.has(account.id)) throw new Error(`${account.label} refused the connection`);
		return this.inbox.filter((item) => item.account === account.id && Date.parse(item.date) > since.getTime());
	}
	async read(account: MailAccount, mailbox: string, uid: number): Promise<MailMessage | undefined> {
		const found = this.inbox.find((item) => item.id === `${account.id}|${mailbox}|${uid}`);
		return found
			? { ...found, to: "me@example.com", text: "Your bill is 39,99 €.", attachments: ["rechnung.pdf"], messageId: "<bill-5@stadtwerke.de>", references: ["<earlier@stadtwerke.de>"], replyTo: "kundenservice@stadtwerke.de" }
			: undefined;
	}
	drafts: Array<{ account: string; raw: Buffer }> = [];
	async saveDraft(account: MailAccount, raw: Buffer) {
		this.drafts.push({ account: account.id, raw });
		return account.id === "gmail" ? "Drafts" : "Entwürfe";
	}
	sent: Array<{ account: string; smtp?: string; envelope: { from: string; to: string[] }; raw: Buffer }> = [];
	filed: string[] = [];
	async send(account: MailAccount, raw: Buffer, envelope: { from: string; to: string[] }) {
		this.sent.push({ account: account.id, smtp: account.smtp?.host, envelope, raw });
	}
	async saveSent(account: MailAccount) {
		this.filed.push(account.id);
	}
}

const connector = (id: string, preset: string, values: Record<string, string>, password: string) => ({ id, kind: "mail", preset, name: preset === "gmail" ? "Gmail" : preset === "gmx" ? "GMX" : "Work", enabled: true, values, secrets: { password }, createdAt: "" });
const accounts = [
	mailAccount(connector("gmail", "gmail", { address: "me@gmail.com" }, "abcd efgh ijkl mnop"))!,
	mailAccount(connector("gmx", "gmx", { address: "me@gmx.de" }, "secret"))!,
];

test("a connector becomes a mail account, with the app password's spaces dropped", () => {
	assert.deepEqual(accounts.map((account) => [account.id, account.host, account.port, account.provider]), [["gmail", "imap.gmail.com", 993, "gmail"], ["gmx", "imap.gmx.net", 993, "imap"]]);
	assert.equal(accounts[0].pass, "abcdefghijklmnop");
	assert.equal(mailAccount(connector("x", "gmx", { address: "me@gmx.de" }, "")), undefined, "no password, no account");
	const other = mailAccount(connector("w", "imap", { address: "me", host: "mail.example.com", port: "143" }, "pw"))!;
	assert.deepEqual([other.host, other.port, other.provider], ["mail.example.com", 143, "imap"]);
});

test("search covers both accounts, newest first, and a failing one is reported", async () => {
	const source = new FakeSource();
	source.inbox = [mail("gmail", 1, { subject: "Rechnung Oktober" }), mail("gmx", 5, { subject: "Rechnung Strom" }), mail("gmx", 2, { subject: "Hi" })];
	const boxes = new Mailboxes(accounts, source);
	const found = await boxes.search("rechnung");
	assert.deepEqual(found.mails.map((item) => item.subject), ["Rechnung Strom", "Rechnung Oktober"]);
	source.failing.add("gmail");
	const partial = await boxes.search("rechnung");
	assert.deepEqual(partial.problems, ["Gmail refused the connection"]);
	assert.equal(partial.mails.length, 1);
	await assert.rejects(boxes.search("x", { account: "outlook" }), /No mailbox called outlook/);
	await assert.rejects(boxes.read("gmail|INBOX|abc"), /isn't a mail id/);
});

test("the assistant can search and read mail, and never delete or move it", async () => {
	const source = new FakeSource();
	source.inbox = [mail("gmx", 3, { subject: "Rechnung Strom", from: "Stadtwerke <rechnung@sw.de>" })];
	const tools = await buildTools({ confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false }, mail: new Mailboxes(accounts, source) }, { nativeWebSearch: true });
	const names = tools.map((tool) => tool.spec.name);
	assert.ok(names.includes("search_mail") && names.includes("read_mail"));
	assert.ok(!names.some((name) => /delete|move|trash|archive/.test(name)), "nothing deletes or moves mail");
	assert.deepEqual(names.filter((name) => /send/.test(name)), ["send_mail"], "the one way to send, and it waits for a tap");
	const found = JSON.parse((await runTool(tools, { id: "1", name: "search_mail", input: { query: "strom" } }, newEffects())).content);
	assert.equal(found.mails[0].id, "gmx|INBOX|3");
	const read = JSON.parse((await runTool(tools, { id: "2", name: "read_mail", input: { id: "gmx|INBOX|3" } }, newEffects())).content);
	assert.equal(read.text, "Your bill is 39,99 €.");
	assert.deepEqual(read.attachments, ["rechnung.pdf"]);
	const none = await buildTools({ confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false }, mail: new Mailboxes([], source) }, { nativeWebSearch: true });
	assert.ok(!none.some((tool) => tool.spec.name === "search_mail"), "no accounts, no mail tools");
});

test("newsletters stay out; bills and orders count even from mailing lists", () => {
	assert.equal(worthKnowing(mail("gmx", 1, { bulk: true }), "newsletter"), false);
	assert.equal(worthKnowing(mail("gmx", 1, { bulk: true }), "invoices"), true);
	assert.equal(worthKnowing(mail("gmx", 1, { bulk: true }), undefined), false);
	assert.equal(worthKnowing(mail("gmx", 1), undefined), true);
	assert.equal(worthKnowing(mail("gmx", 1), "social"), false);
});

test("the AI's findings are checked before anything is sent", () => {
	const ids = new Set(["gmx|INBOX|1", "gmx|INBOX|2"]);
	const findings = parseFindings(
		'```json\n[{"id":"gmx|INBOX|1","kind":"bill","what":"Stadtwerke electricity","amount":"39,99 €","due":"2026-11-05"},{"id":"gmx|INBOX|2","kind":"appointment","what":"Dentist Dr. Wolf","at":"2026-11-04T10:30"},{"id":"other","kind":"bill","what":"x"},{"id":"gmx|INBOX|2","kind":"party","what":"y"}]\n```',
		ids,
	);
	assert.equal(findings.length, 2);
	assert.equal(findingText(findings[0]), "🧾 New bill: Stadtwerke electricity, 39,99 €, due Thu 5 Nov.");
	assert.equal(findingText(findings[1]), "📅 Dentist Dr. Wolf: Wed 4 Nov at 10:30.");
	assert.deepEqual(parseFindings("not json", ids), []);
});

test("the inbox sorter labels mail, and its absence is not an error", async () => {
	const mails = [mail("gmx", 1), mail("gmx", 2)];
	const fetcher = (async (_url: string | URL, init?: RequestInit) => {
		assert.deepEqual(JSON.parse(String(init?.body)).mails[0], { from: "someone@example.com", subject: "Mail 1", body: "Hello" });
		return Response.json({ results: [{ label: "invoices" }, { label: "newsletter" }] });
	}) as typeof fetch;
	const labels = await sortMail("http://sorter:8095/", mails, fetcher);
	assert.deepEqual([...labels.values()], ["invoices", "newsletter"]);
	const down = await sortMail("http://sorter:8095", mails, (async () => {
		throw new Error("connection refused");
	}) as typeof fetch);
	assert.equal(down.size, 0);
});

test("the watcher starts quietly, then reports new bills and appointments and the day before a bill is due", async () => {
	const source = new FakeSource();
	const sent: string[] = [];
	const prompts: string[] = [];
	const watch = new MailWatch({
		mailboxes: new Mailboxes(accounts, source),
		sorterUrl: "http://sorter",
		fetcher: (async (_url: string | URL, init?: RequestInit) =>
			Response.json({ results: JSON.parse(String(init?.body)).mails.map((item: { subject: string }) => ({ label: /Newsletter/.test(item.subject) ? "newsletter" : /Rechnung/.test(item.subject) ? "invoices" : "inbox" })) })) as typeof fetch,
		ask: async (prompt) => {
			prompts.push(prompt);
			return JSON.stringify([
				{ id: "gmx|INBOX|11", kind: "bill", what: "Stadtwerke electricity", amount: "39,99 €", due: "2026-11-05" },
				{ id: "gmail|INBOX|12", kind: "appointment", what: "Dentist", at: "2026-11-04T10:30" },
			]);
		},
		notify: async (text) => {
			sent.push(text);
			return true;
		},
		nudges: true,
		statePath: join(mkdtempSync(join(tmpdir(), "mail-")), "mail.json"),
	});
	source.inbox = [mail("gmx", 1, { subject: "Old mail", date: "2026-10-27T08:00:00.000Z" })];
	await watch.check(new Date("2026-10-28T09:00:00Z"));
	assert.equal(source.calls.length, 0, "the first run only notes the time");
	source.inbox.push(
		mail("gmx", 11, { subject: "Ihre Rechnung", date: "2026-10-28T09:05:00.000Z", bulk: true }),
		mail("gmail", 12, { subject: "Terminbestätigung", date: "2026-10-28T09:06:00.000Z" }),
		mail("gmx", 13, { subject: "Newsletter Oktober", date: "2026-10-28T09:07:00.000Z", bulk: true }),
	);
	await watch.check(new Date("2026-10-28T09:15:00Z"));
	assert.deepEqual(watch.digest().map((item) => item.subject), ["Ihre Rechnung", "Terminbestätigung"]);
	assert.deepEqual(sent, ["🧾 New bill: Stadtwerke electricity, 39,99 €, due Thu 5 Nov.", "📅 Dentist: Wed 4 Nov at 10:30."]);
	assert.doesNotMatch(prompts[0], /Newsletter/, "newsletters never reach the AI");
	await watch.check(new Date("2026-10-28T09:30:00Z"));
	assert.equal(sent.length, 2, "nothing twice");
	await watch.dueTomorrow(new Date("2026-11-03T18:00:00"));
	assert.equal(sent.length, 2);
	await watch.dueTomorrow(new Date("2026-11-04T18:00:00"));
	await watch.dueTomorrow(new Date("2026-11-04T19:00:00"));
	assert.deepEqual(sent.slice(2), ["🧾 Due tomorrow: Stadtwerke electricity, 39,99 €."]);
	await watch.clearDigest();
	assert.deepEqual(watch.digest(), []);
});

test("connector passwords are stored privately and never shown", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "connectors-")), "connectors.json");
	const store = new ConnectorStore(path);
	const saved = await store.create({ kind: "mail", preset: "gmx", name: "GMX", enabled: true, values: { address: "me@gmx.de" }, secrets: { password: "hunter2" } });
	assert.equal(statSync(path).mode & 0o777, 0o600);
	const shown = publicView(saved);
	assert.deepEqual(shown.secretsSet, ["password"]);
	assert.ok(!JSON.stringify(shown).includes("hunter2"));
	await store.update(saved.id, { secrets: { password: "" }, enabled: false });
	assert.equal(store.get(saved.id)?.secrets.password, "hunter2", "a blank password keeps the stored one");
	const reloaded = new ConnectorStore(path);
	await reloaded.load();
	assert.equal(reloaded.list("mail")[0].enabled, false);
	assert.equal(await reloaded.remove(saved.id), true);
});

test("the add form is checked before anything is tested or saved", () => {
	assert.deepEqual(checkMailInput({ preset: "gmail", values: { address: " me@gmail.com " }, secrets: { password: "abcd efgh" } }, true), { preset: "gmail", name: "Gmail", values: { address: "me@gmail.com" }, secrets: { password: "abcd efgh" } });
	assert.throws(() => checkMailInput({ preset: "outlook", values: { address: "me@outlook.com" } }, true), /Pick a mail service/);
	assert.throws(() => checkMailInput({ preset: "gmx", values: { address: "nope" }, secrets: { password: "x" } }, true), /full email address/);
	assert.throws(() => checkMailInput({ preset: "gmx", values: { address: "me@gmx.de" } }, true), /Enter the password/);
	assert.throws(() => checkMailInput({ preset: "imap", values: { address: "me", host: "bad host!" }, secrets: { password: "x" } }, true), /IMAP server name/);
	assert.deepEqual(checkMailInput({ preset: "imap", name: "Work", values: { address: "me", host: "mail.example.com", port: "993" }, secrets: { password: "x" } }, true).values, { address: "me", host: "mail.example.com", port: "993" });
});

test("Gmail and GMX from the app options become connectors once, and follow a new password", async () => {
	const store = new ConnectorStore(join(mkdtempSync(join(tmpdir(), "import-")), "connectors.json"));
	const env = { GMAIL_ADDRESS: "me@gmail.com", GMAIL_APP_PASSWORD: "one", GMX_ADDRESS: "", GMX_PASSWORD: "" };
	await importMailOptions(store, env);
	await importMailOptions(store, env);
	assert.deepEqual(store.list().map((item) => [item.preset, item.name, item.values.address, item.fromOptions]), [["gmail", "Gmail", "me@gmail.com", true]]);
	await importMailOptions(store, { ...env, GMAIL_APP_PASSWORD: "two" });
	assert.equal(store.list()[0].secrets.password, "two");
});

test("each account's last check is kept for the console", async () => {
	const source = new FakeSource();
	source.failing.add("gmx");
	const boxes = new Mailboxes(() => accounts, source);
	await boxes.recent(new Date(0));
	assert.equal(boxes.status("gmail")?.ok, true);
	assert.equal(boxes.status("gmx")?.ok, false);
	assert.match(boxes.status("gmx")?.error || "", /refused/);
	assert.equal(await boxes.test(accounts[0]), "Connected: 3 messages in the inbox.");
});

test("a reply is saved as a draft under the original, and nothing is sent", async () => {
	const source = new FakeSource();
	source.inbox = [mail("gmx", 5, { subject: "Ihre Rechnung", from: "Stadtwerke <billing@stadtwerke.de>" })];
	const tools = await buildTools({ confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false }, mail: new Mailboxes(accounts, source) }, { nativeWebSearch: true });
	const effects = newEffects();
	const result = await runTool(tools, { id: "1", name: "draft_mail", input: { reply_to: "gmx|INBOX|5", text: "Danke, ich überweise morgen.\nGabor" } }, effects);
	assert.ok(!result.isError, result.content);
	assert.deepEqual(JSON.parse(result.content), { saved: true, account: "GMX", folder: "Entwürfe", to: "kundenservice@stadtwerke.de", subject: "Re: Ihre Rechnung", sent: false });
	assert.equal(source.drafts.length, 1);
	assert.equal(source.drafts[0].account, "gmx", "a reply goes to the mailbox the mail came to");
	const draft = await simpleParser(source.drafts[0].raw);
	assert.equal(draft.subject, "Re: Ihre Rechnung");
	assert.equal(draft.from?.text, "me@gmx.de");
	assert.equal((Array.isArray(draft.to) ? draft.to[0] : draft.to)?.text, "kundenservice@stadtwerke.de", "Reply-To wins over the sender");
	assert.equal(draft.inReplyTo, "<bill-5@stadtwerke.de>");
	assert.deepEqual(draft.references, ["<earlier@stadtwerke.de>", "<bill-5@stadtwerke.de>"]);
	assert.equal(draft.text?.trim(), "Danke, ich überweise morgen.\nGabor");
	assert.deepEqual(effects.did, [{ text: "Saved a draft to kundenservice@stadtwerke.de in GMX Entwürfe" }]);
});

test("a new mail needs an address and a subject, and goes to the chosen mailbox", async () => {
	const source = new FakeSource();
	source.inbox = [mail("gmail", 6, { subject: "AW: Termin" })];
	const boxes = new Mailboxes(accounts, source);
	await assert.rejects(boxes.draft({ text: "Hallo", subject: "Hallo" }), /address it goes to/);
	await assert.rejects(boxes.draft({ text: "Hallo", to: "anna@example.com" }), /subject/);
	await assert.rejects(boxes.draft({ text: "Hallo", to: "anna@example.com", subject: "Hi", account: "Yahoo" }), /No mailbox called Yahoo/);
	const saved = await boxes.draft({ text: "Hallo Anna", to: "anna@example.com", subject: "Samstag", account: "Gmail" });
	assert.deepEqual([saved.account.id, saved.folder, saved.to, saved.subject], ["gmail", "Drafts", "anna@example.com", "Samstag"]);
	const reply = await boxes.draft({ text: "Passt.", replyTo: "gmail|INBOX|6" });
	assert.equal(reply.subject, "AW: Termin", "an answered subject isn't prefixed twice");
	assert.ok(!(await simpleParser(source.drafts[0].raw)).inReplyTo, "a new mail isn't threaded");
});

test("send_mail waits for a tap, then sends from the right account and files a copy", async () => {
	const source = new FakeSource();
	source.inbox = [mail("gmx", 5, { subject: "Ihre Rechnung", from: "Stadtwerke <billing@stadtwerke.de>" })];
	const confirmations = new ConfirmationStore();
	const tools = await buildTools({ confirmations, reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false }, mail: new Mailboxes(accounts, source) }, { nativeWebSearch: true });
	const effects = newEffects();
	const result = await runTool(tools, { id: "1", name: "send_mail", input: { reply_to: "gmx|INBOX|5", text: "Danke, ich überweise morgen.\nGabor" } }, effects);
	assert.deepEqual(JSON.parse(result.content), { waiting_for_user_to_confirm: 'Send "Re: Ihre Rechnung" to kundenservice@stadtwerke.de', from: "GMX" });
	assert.equal(source.sent.length, 0, "nothing goes out before the tap");
	assert.equal(effects.confirms[0].entityId, "mail");
	assert.equal(effects.confirms[0].detail, "Danke, ich überweise morgen.\nGabor", "the card shows what will be sent");
	const held = confirmations.take(effects.confirms[0].token)!;
	await held.perform();
	assert.deepEqual(source.sent.map((item) => [item.account, item.smtp, item.envelope]), [["gmx", "mail.gmx.net", { from: "me@gmx.de", to: ["kundenservice@stadtwerke.de"] }]]);
	assert.deepEqual(source.filed, ["gmx"], "GMX doesn't keep sent mail by itself, so a copy goes to Sent");
	const message = await simpleParser(source.sent[0].raw);
	assert.equal(message.inReplyTo, "<bill-5@stadtwerke.de>");

	const fromGmail = new Mailboxes(accounts, source);
	await fromGmail.send(await fromGmail.compose({ text: "Hallo", to: "Anna <anna@example.com>, bob@example.com", subject: "Samstag", account: "Gmail" }));
	assert.deepEqual(source.sent[1].envelope.to, ["anna@example.com", "bob@example.com"]);
	assert.deepEqual(source.filed, ["gmx"], "Gmail files its own sent mail");
});

test("only a mailbox with an outgoing server can send", async () => {
	assert.deepEqual(accounts.map((account) => account.smtp?.host), ["smtp.gmail.com", "mail.gmx.net"]);
	const plain = mailAccount(connector("w", "imap", { address: "me@example.com", host: "mail.example.com", port: "993" }, "pw"))!;
	assert.equal(plain.smtp, undefined);
	const source = new FakeSource();
	const tools = await buildTools({ confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false }, mail: new Mailboxes([plain], source) }, { nativeWebSearch: true });
	const refused = await runTool(tools, { id: "1", name: "send_mail", input: { to: "a@example.com", subject: "Hi", text: "Hi" } }, newEffects());
	assert.equal(refused.isError, true);
	assert.match(refused.content, /no outgoing server/);
	assert.deepEqual(checkMailInput({ preset: "imap", values: { address: "me", host: "mail.example.com", port: "993", smtpHost: "smtp.example.com", smtpPort: "465" }, secrets: { password: "x" } }, true).values, { address: "me", host: "mail.example.com", port: "993", smtpHost: "smtp.example.com", smtpPort: "465" });
	const withSmtp = mailAccount(connector("w", "imap", { address: "me@example.com", host: "mail.example.com", port: "993", smtpHost: "smtp.example.com", smtpPort: "465" }, "pw"))!;
	assert.deepEqual(withSmtp.smtp, { host: "smtp.example.com", port: 465, secure: true });
	assert.throws(() => checkMailInput({ preset: "imap", values: { address: "me", host: "mail.example.com", smtpHost: "bad host" }, secrets: { password: "x" } }, true), /SMTP server name/);
	assert.deepEqual(recipients("Anna <anna@example.com>; not-an-address, team: x@example.org, y@example.org;"), ["anna@example.com", "x@example.org", "y@example.org"]);
});

test("a refused login says what the server meant, not \"Command failed\"", () => {
	const gmail = { label: "Gmail", host: "imap.gmail.com", provider: "gmail" as const };
	const imapError = (text: string) => Object.assign(new Error("Command failed"), { responseText: text });
	assert.match(refusal(gmail, imapError("[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)")), /wants an app password, not your normal Google password\. Make one at myaccount\.google\.com\/apppasswords/);
	assert.match(refusal(gmail, imapError("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")), /never accepts your normal Google password in other apps/);
	assert.match(refusal(gmail, imapError("[ALERT] Please log in via your web browser: https://support.google.com/mail/accounts/answer/78754 (Failure)")), /blocked the sign-in as unusual/);
	assert.match(refusal(gmail, new Error("Invalid login: 534-5.7.9 Application-specific password required.")), /wants an app password/, "SMTP's wording too");
	assert.match(refusal({ ...gmail, token: async () => "t" }, imapError("[AUTHENTICATIONFAILED] Invalid credentials (Failure)")), /Sign in again/);
	assert.match(refusal({ label: "GMX", host: "imap.gmx.net", provider: "imap" }, imapError("[AUTHENTICATIONFAILED] authentication failed")), /POP3\/IMAP Abruf/);
	assert.equal(refusal({ label: "Work", host: "mail.example.com", provider: "imap" }, new Error("connect ETIMEDOUT")), "Work refused the connection (connect ETIMEDOUT). Check the address, password and server under Settings, Connectors.");
});
