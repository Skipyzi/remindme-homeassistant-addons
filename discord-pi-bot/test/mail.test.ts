import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Mailboxes, mailAccounts, type MailAccount, type MailMessage, type MailSource, type MailSummary } from "../src/mail/mailboxes.ts";
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
	inbox: MailSummary[] = [];
	failing = new Set<string>();
	async search(account: MailAccount, query: string, _since: Date, limit: number) {
		this.calls.push(`search ${account.id} ${query}`);
		if (this.failing.has(account.id)) throw new Error(`${account.label} refused the connection`);
		return this.inbox.filter((item) => item.account === account.id && item.subject.toLowerCase().includes(query.toLowerCase())).slice(-limit);
	}
	async recent(account: MailAccount, since: Date) {
		this.calls.push(`recent ${account.id}`);
		return this.inbox.filter((item) => item.account === account.id && Date.parse(item.date) > since.getTime());
	}
	async read(account: MailAccount, mailbox: string, uid: number): Promise<MailMessage | undefined> {
		const found = this.inbox.find((item) => item.id === `${account.id}|${mailbox}|${uid}`);
		return found ? { ...found, to: "me@example.com", text: "Your bill is 39,99 €.", attachments: ["rechnung.pdf"] } : undefined;
	}
}

const accounts = mailAccounts({ GMAIL_ADDRESS: "me@gmail.com", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop", GMX_ADDRESS: "me@gmx.de", GMX_PASSWORD: "secret" });

test("accounts come from the options, with the app password's spaces dropped", () => {
	assert.deepEqual(accounts.map((account) => [account.id, account.host, account.port]), [["gmail", "imap.gmail.com", 993], ["gmx", "imap.gmx.net", 993]]);
	assert.equal(accounts[0].pass, "abcdefghijklmnop");
	assert.deepEqual(mailAccounts({ GMAIL_ADDRESS: "me@gmail.com" }), [], "an address without a password is not an account");
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

test("the assistant can search and read mail, and never gets other tools for it", async () => {
	const source = new FakeSource();
	source.inbox = [mail("gmx", 3, { subject: "Rechnung Strom", from: "Stadtwerke <rechnung@sw.de>" })];
	const tools = await buildTools({ confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false }, mail: new Mailboxes(accounts, source) }, { nativeWebSearch: true });
	const names = tools.map((tool) => tool.spec.name);
	assert.ok(names.includes("search_mail") && names.includes("read_mail"));
	assert.ok(!names.some((name) => /send|delete|move/.test(name)), "read-only");
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
