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
		if (url === "http://supervisor/addons") {
			return Response.json({
				data: {
					addons: [{ slug: "local_local_llama_cpp", name: "Local llama.cpp" }],
				},
			});
		}
		if (url === "http://supervisor/addons/local_local_llama_cpp/options") {
			return Response.json({ result: "ok" });
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

	await context.test(
		"catalog pairs and proxies without exposing manager secret",
		async () => {
			const response = await nativeFetch(`${baseUrl}/api/models`);
			assert.equal(response.status, 200);
			const body = await response.json();
			assert.deepEqual(body, managerCatalog);
			assert.match(managerAuthorization, /^Bearer [A-Za-z0-9_-]{32,}$/);
			assert.equal(
				JSON.stringify(body).includes(managerAuthorization.slice(7)),
				false,
			);
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
