import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ModelManagerClient,
	ModelManagerError,
	deriveManagerUrl,
	ensureModelManagerPairing,
	readManagerToken,
} from "../src/harness/modelManager";

test("derives the manager root from the internal completion endpoint", () => {
	assert.equal(
		deriveManagerUrl("http://homeassistant:8080/v1/chat/completions"),
		"http://homeassistant:8080/manager/v1",
	);
	assert.throws(() =>
		deriveManagerUrl("https://public.example/v1/chat/completions"),
	);
});

test("pairs by updating the discovered llama add-on without returning the token", async () => {
	const directory = await mkdtemp(join(tmpdir(), "manager-pairing-"));
	const secretPath = join(directory, "manager-token");
	let saved: unknown;
	const pairing = await ensureModelManagerPairing({
		secretPath,
		listAddons: async () => [
			{ slug: "local_local_llama_cpp", name: "Local llama.cpp" },
		],
		updateOptions: async (slug, options) => {
			saved = { slug, options };
		},
		randomBytes: () => Buffer.alloc(32, 7),
	});
	const expected = Buffer.alloc(32, 7).toString("base64url");
	assert.deepEqual(pairing, {
		addonSlug: "local_local_llama_cpp",
		configured: true,
	});
	assert.deepEqual(saved, {
		slug: "local_local_llama_cpp",
		options: { manager_token: expected },
	});
	assert.equal(await readFile(secretPath, "utf8"), expected);
	if (process.platform !== "win32") {
		assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
	}
});

test("reuses the persisted pairing secret", async () => {
	const directory = await mkdtemp(join(tmpdir(), "manager-pairing-"));
	const secretPath = join(directory, "manager-token");
	const dependencies = {
		secretPath,
		listAddons: async () => [{ slug: "local_llama_cpp" }],
		updateOptions: async () => {},
		randomBytes: () => Buffer.alloc(32, 9),
	};
	await ensureModelManagerPairing(dependencies);
	const first = await readManagerToken(secretPath);
	await ensureModelManagerPairing({
		...dependencies,
		randomBytes: () => Buffer.alloc(32, 1),
	});
	assert.equal(await readManagerToken(secretPath), first);
});

test("client sends the secret server-side and maps safe errors", async () => {
	let authorization = "";
	const client = new ModelManagerClient(
		"http://homeassistant:8080/manager/v1",
		async () => "manager-secret",
		async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization") || "";
			return new Response(
				JSON.stringify({
					code: "model_not_found",
					message: "Model was not found.",
				}),
				{ status: 404, headers: { "content-type": "application/json" } },
			);
		},
	);
	await assert.rejects(
		client.request("/catalog"),
		(error: unknown) =>
			error instanceof ModelManagerError &&
			error.code === "model_not_found" &&
			error.status === 404,
	);
	assert.equal(authorization, "Bearer manager-secret");
});
