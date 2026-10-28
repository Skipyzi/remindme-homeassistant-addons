import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mailAccount } from "../src/connectors/mail.ts";
import { GoogleApp, GoogleContacts, GoogleTokens, MAIL_SCOPE, OTHER_CONTACTS, SAVED_CONTACTS, checkGoogleApp, googleAccount, googleRedirect, googleSignInUrl, type GoogleEndpoints } from "../src/connectors/google.ts";
import { SignInExpired, SignIns, exchangeCode, pkcePair, refreshTokens, signInPage } from "../src/connectors/oauth.ts";
import type { StoredConnector } from "../src/connectors/store.ts";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const endpoints: GoogleEndpoints = { authorize: "https://g.test/auth", token: "https://g.test/token", revoke: "https://g.test/revoke", userinfo: "https://g.test/userinfo", people: "https://g.test/v1" };

test("a PKCE challenge is the SHA-256 of its verifier", () => {
	const { verifier, challenge } = pkcePair();
	assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("a sign-in's state works once and runs out after ten minutes; the console's handle reports the outcome", () => {
	const signIns = new SignIns<{ kind: string }>();
	const started = signIns.start("abcdef123456", { kind: "google" }, 0);
	assert.equal(started.handle, "abcdef123456");
	assert.deepEqual(signIns.result("abcdef123456", 1), { state: "waiting", text: "Waiting for the sign-in." });
	assert.equal(signIns.take(started.state, 1)?.data.kind, "google");
	assert.equal(signIns.take(started.state, 2), undefined, "used up");
	signIns.finish("abcdef123456", true, "Connected.", 3);
	assert.deepEqual(signIns.result("abcdef123456", 4), { state: "done", text: "Connected." });

	const late = signIns.start("<script>", { kind: "mcp" }, 0);
	assert.notEqual(late.handle, "<script>", "a handle that isn't plain is replaced");
	assert.equal(signIns.take(late.state, 11 * 60_000), undefined);
});

test("the code is swapped with the client's secret the way the server wants it", async () => {
	const seen: Array<{ body: URLSearchParams; auth?: string }> = [];
	const fake = (async (_url: string, init: RequestInit) => {
		seen.push({ body: new URLSearchParams(String(init.body)), auth: (init.headers as Record<string, string>).Authorization });
		return json(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "a b" });
	}) as typeof fetch;
	const input = { code: "c", verifier: "v", redirectUri: "https://r.test/cb" };
	const tokens = await exchangeCode(endpoints, { id: "id", secret: "s3", method: "client_secret_post" }, input, fake);
	assert.equal(tokens.accessToken, "at");
	assert.equal(tokens.refreshToken, "rt");
	assert.equal(tokens.scope, "a b");
	assert.ok(tokens.expiresAt && tokens.expiresAt > Date.now());
	assert.equal(seen[0].body.get("client_secret"), "s3");
	assert.equal(seen[0].body.get("code_verifier"), "v");
	assert.equal(seen[0].body.get("grant_type"), "authorization_code");

	await exchangeCode(endpoints, { id: "id:1", secret: "s 3", method: "client_secret_basic" }, input, fake);
	assert.equal(seen[1].auth, `Basic ${Buffer.from("id%3A1:s%203").toString("base64")}`);
	assert.equal(seen[1].body.get("client_secret"), null);

	await exchangeCode(endpoints, { id: "public" }, { ...input, resource: "https://mcp.test/mcp" }, fake);
	assert.equal(seen[2].body.get("client_id"), "public");
	assert.equal(seen[2].body.get("resource"), "https://mcp.test/mcp");
});

test("a revoked refresh token says to sign in again; other failures say what the server said", async () => {
	const revoked = (async () => json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })) as typeof fetch;
	await assert.rejects(refreshTokens(endpoints, { id: "id" }, { refreshToken: "rt" }, revoked), SignInExpired);
	const broken = (async () => json(500, { error: "server_error" })) as typeof fetch;
	await assert.rejects(refreshTokens(endpoints, { id: "id" }, { refreshToken: "rt" }, broken), /server_error/);
});

test("the landing page escapes whatever a service sends back", () => {
	const page = signInPage(false, "Not signed in", '<img src=x onerror="alert(1)">');
	assert.ok(!page.includes("<img"));
	assert.match(page, /&#60;img/);
});

test("Google's redirect and domain come from the phone app's address", () => {
	assert.deepEqual(googleRedirect("https://remindme.tailce5634.ts.net"), { redirectUri: "https://remindme.tailce5634.ts.net/api/oauth/callback", domain: "tailce5634.ts.net" });
	const url = new URL(googleSignInUrl({ clientId: "1.apps.googleusercontent.com", clientSecret: "s" }, { redirectUri: "https://r.test/cb", state: "st", challenge: "ch", loginHint: "me@gmail.com" }, endpoints));
	assert.equal(url.searchParams.get("access_type"), "offline");
	assert.equal(url.searchParams.get("prompt"), "consent");
	assert.equal(url.searchParams.get("code_challenge_method"), "S256");
	assert.equal(url.searchParams.get("login_hint"), "me@gmail.com");
	for (const scope of [MAIL_SCOPE, SAVED_CONTACTS, OTHER_CONTACTS, "email"]) assert.ok(url.searchParams.get("scope")?.split(" ").includes(scope), scope);
});

test("a Google app needs a real client id and a secret; the secret can stay when only re-saved", () => {
	assert.throws(() => checkGoogleApp({ clientId: "nope", clientSecret: "s" }), /apps\.googleusercontent\.com/);
	assert.throws(() => checkGoogleApp({ clientId: "1-a.apps.googleusercontent.com" }), /secret/);
	const current = { clientId: "1-a.apps.googleusercontent.com", clientSecret: "GOCSPX-old" };
	assert.deepEqual(checkGoogleApp({ clientId: " 1-a.apps.googleusercontent.com ", clientSecret: "" }, current), current);
	assert.throws(() => checkGoogleApp({ clientId: "2-b.apps.googleusercontent.com", clientSecret: "" }, current), /secret/);
});

test("a Google sign-in counts only with mail allowed and a refresh token", async () => {
	const userinfo = (async () => json(200, { email: "me@gmail.com", email_verified: true })) as typeof fetch;
	await assert.rejects(googleAccount({ accessToken: "a", refreshToken: "r", scope: `openid ${SAVED_CONTACTS}` }, userinfo, endpoints), /leave the Gmail box ticked/);
	await assert.rejects(googleAccount({ accessToken: "a", scope: MAIL_SCOPE }, userinfo, endpoints), /lasting access/);
	assert.deepEqual(await googleAccount({ accessToken: "a", refreshToken: "r", scope: MAIL_SCOPE }, userinfo, endpoints), { email: "me@gmail.com", scope: MAIL_SCOPE });
});

const googleConnector = (values: Record<string, string> = {}, secrets: Record<string, string> = { refreshToken: "rt" }): StoredConnector => ({
	id: "g1",
	kind: "mail",
	preset: "gmail",
	name: "Gmail",
	enabled: true,
	values: { address: "me@gmail.com", auth: "google", scope: MAIL_SCOPE, ...values },
	secrets,
	createdAt: "",
});

test("Gmail signed in with Google opens with a token instead of a password", async () => {
	assert.equal(mailAccount(googleConnector()), undefined, "no token source, no account");
	assert.equal(mailAccount(googleConnector({}, {}), async () => "x"), undefined, "no refresh token, no account");
	const account = mailAccount(googleConnector({}, { refreshToken: "rt", password: "old app password" }), async (connector) => `token for ${connector.id}`);
	assert.ok(account);
	assert.equal(account.pass, "", "the old password isn't used");
	assert.equal(await account.token?.(), "token for g1");
	assert.equal(account.provider, "gmail");
	assert.equal(account.smtp?.host, "smtp.gmail.com");
	const withPassword = mailAccount({ ...googleConnector({ auth: "" }, { password: "abcd efgh ijkl mnop" }) });
	assert.equal(withPassword?.pass, "abcdefghijklmnop");
	assert.equal(withPassword?.token, undefined);
});

test("access tokens are reused for their hour, refreshed once when run out, and a revoked sign-in says so", async () => {
	const app = new GoogleApp(join(mkdtempSync(join(tmpdir(), "google-")), "app.json"));
	await app.save({ clientId: "1.apps.googleusercontent.com", clientSecret: "s" });
	let calls = 0;
	let answer: () => Response = () => json(200, { access_token: `at${++calls}`, expires_in: 3600 });
	const tokens = new GoogleTokens(app, (async () => answer()) as typeof fetch, () => endpoints);
	const connector = googleConnector();
	const [first, second] = await Promise.all([tokens.token(connector), tokens.token(connector)]);
	assert.equal(first, "at1");
	assert.equal(second, "at1", "two at once share one refresh");
	assert.equal(await tokens.token(connector), "at1");
	assert.equal(await tokens.token(connector, Date.now() + 3_590_000), "at2", "near the end of the hour it refreshes");
	tokens.forget("g1");
	answer = () => json(400, { error: "invalid_grant" });
	await assert.rejects(tokens.token(connector), /no longer accepts RemindMe's sign-in for me@gmail\.com\. Sign in again/);
	await app.clear();
	await assert.rejects(tokens.token(connector), /isn't set up any more/);
});

test("contacts come from saved contacts and people written with, once warmed up; a switched-off API says how to fix it", async () => {
	const asked: string[] = [];
	const fake = (async (url: string) => {
		const parsed = new URL(url);
		asked.push(`${parsed.pathname} "${parsed.searchParams.get("query")}"`);
		if (!parsed.searchParams.get("query")) return json(200, {});
		if (parsed.pathname.endsWith("people:searchContacts")) return json(200, { results: [{ person: { names: [{ displayName: "Anna Schmidt" }], emailAddresses: [{ value: "anna@example.com" }] } }] });
		return json(200, { results: [{ person: { emailAddresses: [{ value: "Anna@example.com" }, { value: "anna.work@example.com" }] } }, { person: { names: [{ displayName: "Anna B" }], emailAddresses: [{ value: "annab@example.com" }] } }] });
	}) as typeof fetch;
	let scope = `${MAIL_SCOPE} ${SAVED_CONTACTS} ${OTHER_CONTACTS}`;
	const contacts = new GoogleContacts(() => [{ label: "Gmail", scope, token: async () => "at" }], fake, () => endpoints);
	assert.equal(contacts.available, true);
	const found = await contacts.find("Anna", 0);
	assert.deepEqual(found.people, [
		{ name: "Anna Schmidt", emails: ["anna@example.com", "anna.work@example.com"], account: "Gmail" },
		{ name: "Anna B", emails: ["annab@example.com"], account: "Gmail" },
	]);
	assert.deepEqual(asked, ['/v1/people:searchContacts ""', '/v1/people:searchContacts "Anna"', '/v1/otherContacts:search ""', '/v1/otherContacts:search "Anna"']);
	await contacts.find("Bob", 60_000);
	assert.equal(asked.filter((line) => line.endsWith('""')).length, 2, "warmed up once an hour");

	scope = MAIL_SCOPE;
	assert.equal(contacts.available, false, "contacts unticked: no lookups");

	const disabled = new GoogleContacts(
		() => [{ label: "Gmail", scope: SAVED_CONTACTS, token: async () => "at" }],
		(async () => json(403, { error: { message: "People API has not been used in project 123 before or it is disabled.", status: "PERMISSION_DENIED" } })) as typeof fetch,
		() => endpoints,
	);
	assert.deepEqual((await disabled.find("Anna")).problems, ["Gmail: turn on the People API in your Google Cloud project (APIs & Services, Library), then try again."]);
});

test("the AI gets find_contact only when a Google account allowed contacts", async () => {
	const { buildTools, runTool } = await import("../src/assistant/tools.ts");
	const { ConfirmationStore } = await import("../src/assistant/confirmations.ts");
	const base = { confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false } };
	const people = [{ name: "Anna Schmidt", emails: ["anna@example.com"], account: "Gmail" }];
	const none = await buildTools({ ...base, contacts: { available: false, find: async () => ({ people, problems: [] }) } }, { nativeWebSearch: true });
	assert.ok(!none.some((tool) => tool.spec.name === "find_contact"));
	const tools = await buildTools({ ...base, contacts: { available: true, find: async () => ({ people, problems: [] }) } }, { nativeWebSearch: true });
	const effects = { did: [], confirms: [], cards: [], artifacts: [], receipts: [] } as never;
	const run = await runTool(tools, { id: "1", name: "find_contact", input: { name: "Anna" } }, effects);
	assert.deepEqual(JSON.parse(run.content as string), { people: [{ name: "Anna Schmidt", emails: ["anna@example.com"] }] });
});
