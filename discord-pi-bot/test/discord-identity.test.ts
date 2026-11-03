import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { IdentitySync, discordName } from "../src/discord/identity.ts";

test("the assistant's name becomes a name Discord takes", () => {
	assert.equal(discordName("mochi"), "mochi");
	assert.equal(discordName("  Remi @home  "), "Remi home");
	assert.equal(discordName("Discord Helper"), "Helper");
	assert.equal(discordName("x"), "RemindMe", "too short");
	assert.equal(discordName("everyone"), "RemindMe");
	assert.equal(discordName("Thereza"), "Thereza", "only the bare word is refused");
	assert.equal(discordName("a".repeat(40)).length, 32);
});

/* A stand-in for the bot's client: its user, and one server. */
function fakeClient(options: { renameFails?: boolean } = {}) {
	const calls: string[] = [];
	const me = {
		nickname: null as string | null,
		get displayName() {
			return this.nickname || user.username;
		},
		async setNickname(nick: string | null) {
			calls.push(`nick ${nick}`);
			this.nickname = nick;
		},
	};
	const user = {
		username: "RemindMe",
		async setUsername(name: string) {
			calls.push(`name ${name}`);
			if (options.renameFails) throw new Error("You are changing your username too fast");
			user.username = name;
		},
		async setAvatar(picture: Buffer) {
			calls.push(`avatar ${picture.length}`);
		},
	};
	const client = { user, guilds: { cache: new Map([["g1", { id: "g1", name: "Friends", members: { me } }]]) }, once() {}, on() {} };
	return { client: client as never, calls, me, user };
}

const identity = (name: string, seed: string) => ({ name: () => name, seed: () => seed, avatar: async () => Buffer.from("png"), onChange() {} });

test("the bot takes the assistant's name and cat, and doesn't redo what's done", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "identity-")), "identity.json");
	const { client, calls } = fakeClient();
	const sync = new IdentitySync(client, identity("mochi", "look:2-0"), path, 0);
	await sync.sync();
	assert.deepEqual(calls, ["name mochi", "avatar 3"]);
	calls.length = 0;
	await sync.sync();
	assert.deepEqual(calls, [], "same name, same cat: nothing to send");
});

test("a refused rename shows the name as a nickname, which comes off once the rename lands", async () => {
	const path = join(mkdtempSync(join(tmpdir(), "identity-")), "identity.json");
	const fake = fakeClient({ renameFails: true });
	const sync = new IdentitySync(fake.client, identity("mochi", "look:2-0"), path, 0);
	await sync.sync();
	assert.equal(fake.me.nickname, "mochi");
	assert.ok(fake.calls.includes("avatar 3"));
	// Later Discord takes the name: the nickname it put on goes.
	fake.user.username = "mochi";
	await sync.sync();
	assert.equal(fake.me.nickname, null);
});
