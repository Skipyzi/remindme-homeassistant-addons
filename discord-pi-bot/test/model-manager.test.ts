import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ModelManagerClient,
	ModelManagerError,
	deriveManagerUrl,
	managerPairingConfigured,
	pairModelManager,
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
	assert.throws(() =>
		deriveManagerUrl("http://127.0.0.1:8080/v1/chat/completions"),
	);
	assert.throws(() =>
		deriveManagerUrl("http://localhost:8080/v1/chat/completions"),
	);
});

test("pairs directly without sending a bearer token and persists the secret", async () => {
	const directory = await mkdtemp(join(tmpdir(), "manager-pairing-"));
	const secretPath = join(directory, "manager-token");
	const expected = "manager-token-value-that-is-long-enough-123456";
	let authorization = "unset";
	let submitted = "";
	await pairModelManager(
		"http://homeassistant:8080/manager/v1",
		"ABC234",
		secretPath,
		async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization") || "";
			submitted = String(init?.body);
			return Response.json({ token: expected });
		},
	);
	assert.equal(authorization, "");
	assert.match(submitted, /ABC234/);
	assert.equal(await readFile(secretPath, "utf8"), expected);
	assert.equal(await managerPairingConfigured(secretPath), true);
	if (process.platform !== "win32") {
		assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
	}
});

test("failed pairing preserves an existing valid secret", async () => {
	const directory = await mkdtemp(join(tmpdir(), "manager-pairing-"));
	const secretPath = join(directory, "manager-token");
	const existing = "existing-manager-token-that-must-stay-123456";
	await writeFile(secretPath, existing);
	await assert.rejects(
		pairModelManager(
			"http://homeassistant:8080/manager/v1",
			"ABC234",
			secretPath,
			async () =>
				Response.json(
					{ code: "pairing_invalid", message: "Invalid" },
					{ status: 401 },
				),
		),
		(error: unknown) =>
			error instanceof ModelManagerError && error.code === "pairing_invalid",
	);
	assert.equal(await readManagerToken(secretPath), existing);
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
