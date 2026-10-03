(function exposeProviders(globalScope) {
	const polls = new Map();
	function stopPoll(provider) { clearInterval(polls.get(provider.id)); polls.delete(provider.id); }
	async function request(provider, action, body) {
		const response = await fetch(`./api/auth/${provider.id}/${action}`, body === undefined ? {} : {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.error || "Provider connection failed");
		return data;
	}
	async function status(app, provider) {
		const data = await request(provider, "status");
		Object.assign(provider, data);
		if (!data.pending && provider.attempt) {
			stopPoll(provider);
			if (!data.connected && !data.error) provider.error = "Sign-in expired or was cancelled. Start again.";
			provider.attempt = null;
			provider.code = "";
		}
		if (!data.connected) { provider.models = []; return; }
		if (provider.id === "chatgpt" && localStorage.getItem("remindme.chatgpt-plan-welcome") !== "1") app.chatgptWelcome = true;
		const { models } = await request(provider, "models");
		provider.models = models;
		const saved = app.endpoints.find((endpoint) => endpoint.authProvider === provider.id);
		if (!models.some((model) => model.id === provider.model))
			provider.model = models.find((model) => model.id === saved?.model)?.id
				|| models.find((model) => model.id === "gpt-6-luna")?.id || models[0]?.id || "";
		if (!models.length) provider.error = "Your account returned no available models.";
	}
	async function run(provider, action) {
		if (provider.busy) return;
		provider.busy = true;
		provider.error = "";
		try { await action(); }
		catch (error) { provider.error = error.message || String(error); }
		finally { provider.busy = false; }
	}
	async function load(app) {
		await Promise.all(app.providers.map((provider) => run(provider, () => status(app, provider))));
	}
	async function start(app, provider) {
		await run(provider, async () => {
			provider.code = "";
			provider.attempt = await request(provider, "start", {});
			provider.pending = true;
			stopPoll(provider);
			polls.set(provider.id, setInterval(() => run(provider, () => status(app, provider)), 3000));
			// The explicit link works with popup blockers and Home Assistant ingress.
		});
	}
	async function complete(app, provider) {
		const attempt = provider.attempt;
		if (!attempt) return;
		await run(provider, async () => {
			const code = provider.code;
			provider.code = "";
			await request(provider, "complete", { attemptId: attempt.attemptId, code });
			stopPoll(provider);
			provider.attempt = null;
			await status(app, provider);
		});
	}
	async function cancel(app, provider) {
		await run(provider, async () => {
			await request(provider, "cancel", {});
			stopPoll(provider);
			provider.attempt = null;
			provider.code = "";
			await status(app, provider);
		});
	}
	async function logout(app, provider) {
		await run(provider, async () => {
			await request(provider, "logout", {});
			stopPoll(provider);
			provider.attempt = null;
			provider.code = "";
			await status(app, provider);
			await globalScope.RemindMeEndpoints.load(app);
			await app.refreshStatus?.();
		});
	}
	async function use(app, provider) {
		await run(provider, async () => {
			const config = await request(provider, "endpoint", { model: provider.model });
			app.endpoints = config.endpoints;
			app.endpointActiveId = config.activeId;
			await app.refreshStatus?.();
		});
	}
	globalScope.RemindMeProviders = { load, start, complete, cancel, logout, use };
})(window);
