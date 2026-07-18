import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("model manager routes proxy safely", async (context) => {
	const nativeFetch = globalThis.fetch;
	const directory = await mkdtemp(join(tmpdir(), "manager-routes-"));
	process.env.SUPERVISOR_TOKEN = "supervisor_test_value";
	process.env.MODEL_MANAGER_ENABLED = "true";
	process.env.MODEL_MANAGER_URL = "http://homeassistant:8080/manager/v1";
	process.env.MODEL_MANAGER_TOKEN_PATH = join(directory, "manager-token");

	const pairedToken = "manager-secret-value-that-is-long-enough-123";
	let pairingAuthorization = "unset";
	let pairingBody = "";
	let managerAuthorization = "";
	let credentialBody = "";
	const managerCatalog = {
		variants: [
			{
				model: {
					id: "qwen3-4b-q4",
					family: "Qwen3 4B",
					file: "Qwen3-4B-Q4_K_M.gguf",
				},
				assessment: { safe: true },
			},
		],
	};

	globalThis.fetch = (async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		if (url === "http://homeassistant:8080/manager/v1/pair") {
			pairingAuthorization =
				new Headers(init?.headers).get("authorization") || "";
			pairingBody = String(init?.body || "");
			return Response.json({ token: pairedToken });
		}
		if (url === "http://homeassistant:8080/manager/v1/catalog") {
			managerAuthorization =
				new Headers(init?.headers).get("authorization") || "";
			return Response.json(managerCatalog);
		}
		if (
			url === "http://homeassistant:8080/manager/v1/credentials/huggingface"
		) {
			credentialBody = String(init?.body || "");
			return Response.json({ configured: true });
		}
		return Response.json(
			{
				code: "unexpected_request",
				message: `Unexpected test request: ${url}`,
			},
			{ status: 500 },
		);
	}) as typeof fetch;

	const { createHarnessApp } = await import("../src/harness-server");
	const app = createHarnessApp();
	const server = app.listen(0);
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("No test server address");
	const baseUrl = `http://127.0.0.1:${address.port}`;

	context.after(() => {
		server.close();
		globalThis.fetch = nativeFetch;
	});

	await context.test("starts unpaired and rejects invalid local codes", async () => {
		const before = await nativeFetch(`${baseUrl}/api/models/pairing`);
		assert.deepEqual(await before.json(), { configured: false });
		const catalog = await nativeFetch(`${baseUrl}/api/models`);
		assert.equal(catalog.status, 401);
		assert.equal((await catalog.json()).code, "manager_unpaired");
		const invalid = await nativeFetch(`${baseUrl}/api/models/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: "wrong" }),
		});
		assert.equal(invalid.status, 400);
		assert.equal((await invalid.json()).code, "invalid_request");
	});

	await context.test("pairs directly without Supervisor mutation", async () => {
		const response = await nativeFetch(`${baseUrl}/api/models/pair`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: "ABC234" }),
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { configured: true });
		assert.equal(pairingAuthorization, "");
		assert.equal(pairingBody, JSON.stringify({ code: "ABC234" }));
	});

	await context.test(
		"catalog proxies without exposing manager secret",
		async () => {
			const response = await nativeFetch(`${baseUrl}/api/models`);
			assert.equal(response.status, 200);
			const body = await response.json();
			assert.deepEqual(body, managerCatalog);
			assert.equal(managerAuthorization, `Bearer ${pairedToken}`);
			assert.equal(JSON.stringify(body).includes(pairedToken), false);
		},
	);

	await context.test(
		"credential route never echoes the Hugging Face token",
		async () => {
			const token = "hf_test_value_that_is_not_a_real_token";
			const response = await nativeFetch(`${baseUrl}/api/models/credentials`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token }),
			});
			assert.equal(response.status, 200);
			const responseText = await response.text();
			let parsedResponse: unknown;
			try {
				parsedResponse = JSON.parse(responseText);
			} catch {
				assert.fail(`Credential response was not JSON: ${responseText}`);
			}
			assert.deepEqual(parsedResponse, { configured: true });
			assert.equal(credentialBody, JSON.stringify({ token }));
			assert.equal(responseText.includes(token), false);
		},
	);

	await context.test("Supervisor settings routes are absent", async () => {
		for (const [path, method] of [
			["/api/settings", "GET"],
			["/api/settings/restart", "POST"],
		] as const) {
			const response = await nativeFetch(`${baseUrl}${path}`, { method });
			assert.equal(response.status, 404, `${method} ${path}`);
		}
	});

	await context.test(
		"invalid selection is rejected before upstream access",
		async () => {
			const response = await nativeFetch(`${baseUrl}/api/models/install`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "../unsafe" }),
			});
			assert.equal(response.status, 400);
			assert.equal((await response.json()).code, "invalid_model");
		},
	);
});
