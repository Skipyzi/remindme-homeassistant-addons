import { Router } from "express";
import { chatgptAuth } from "./chatgptAuth";
import { claudeAuth } from "./claudeAuth";
import type { EndpointStore } from "./endpoints";

const claudeModels = [
	{ id: "sonnet", name: "Claude Sonnet" },
	{ id: "opus", name: "Claude Opus" },
	{ id: "haiku", name: "Claude Haiku" },
];

export function providerRoutes(endpoints: EndpointStore): Router {
	const router = Router();
	router.use((_request, response, next) => {
		response.setHeader("Cache-Control", "no-store");
		next();
	});
	// JSON requests cannot be submitted by a cross-origin HTML form. No CORS
	// access is granted; Home Assistant ingress supplies the user's session.
	router.use((request, response, next) => {
		if (request.method === "POST" && !request.is("application/json"))
			return response.status(415).json({ error: "Send an application/json request" });
		next();
	});
	router.use("/:provider", (request, response, next) => {
		if (!["chatgpt", "claude"].includes(request.params.provider))
			return response.status(404).json({ error: "Unknown provider" });
		next();
	});
	const manager = (provider: string) => provider === "chatgpt" ? chatgptAuth : claudeAuth;
	const models = (provider: string) => provider === "chatgpt" ? chatgptAuth.models() : Promise.resolve(claudeModels);
	router.get("/:provider/status", async (request, response) => {
		try { response.json(await manager(request.params.provider).status()); }
		catch { response.status(503).json({ connected: false, error: "The sign-in client is unavailable." }); }
	});
	router.post("/:provider/start", async (request, response) => {
		try { response.json(await manager(request.params.provider).start()); }
		catch (error) { response.status(400).json({ error: message(error) }); }
	});
	router.post("/:provider/complete", async (request, response) => {
		try {
			response.json(await manager(request.params.provider).complete(
				String(request.body?.attemptId || ""), String(request.body?.code || ""),
			));
		} catch (error) { response.status(400).json({ error: message(error) }); }
	});
	router.post("/:provider/cancel", (request, response) => {
		manager(request.params.provider).cancel();
		response.json({ ok: true });
	});
	router.post("/:provider/logout", async (request, response) => {
		try {
			await manager(request.params.provider).logout();
			if (endpoints.active()?.authProvider === request.params.provider) await endpoints.setActive("");
			response.json({ ok: true });
		} catch (error) { response.status(400).json({ error: message(error) }); }
	});
	router.get("/:provider/models", async (request, response) => {
		try { response.json({ models: await models(request.params.provider) }); }
		catch (error) { response.status(400).json({ error: message(error) }); }
	});
	router.post("/:provider/endpoint", async (request, response) => {
		try {
			const provider = request.params.provider as "chatgpt" | "claude";
			if (!(await manager(provider).status()).connected) throw new Error("Sign in before selecting a model.");
			const model = (await models(provider)).find((item) => item.id === request.body?.model);
			if (!model) throw new Error("Choose a model available to your account.");
			const values = {
				name: `${provider === "chatgpt" ? "ChatGPT" : "Claude"} · ${model.name}`,
				model: model.id, authProvider: provider, openaiCompat: true,
				url: provider === "chatgpt" ? "https://api.openai.com/v1/responses" : "https://api.anthropic.com/v1/messages",
			};
			const existing = endpoints.config().endpoints.find((item) => item.authProvider === provider);
			const endpoint = existing ? await endpoints.update(existing.id, values) : await endpoints.create(values);
			await endpoints.setActive(endpoint!.id);
			response.json(endpoints.config());
		} catch (error) { response.status(400).json({ error: message(error) }); }
	});
	return router;
}

function message(error: unknown) { return error instanceof Error ? error.message : "Provider connection failed"; }
