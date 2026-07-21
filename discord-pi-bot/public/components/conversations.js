(function exposeConversations(globalScope) {
	let saveTimer;
	async function load(app) {
		const response = await fetch("./api/conversations");
		app.conversations = response.ok ? await response.json() : [];
		if (!app.currentConversationId && app.conversations[0])
			app.currentConversationId = app.conversations[0].id;
	}
	async function create(app) {
		const response = await fetch("./api/conversations", { method: "POST" });
		if (!response.ok) return;
		const conversation = await response.json();
		app.conversations.unshift(conversation);
		app.currentConversationId = conversation.id;
		app.messages = [];
	}
	/**
	 * Guarantee somewhere to save to.
	 *
	 * A fresh install has no conversations, so nothing set currentConversationId
	 * and save() bailed on every keystroke — the first chat was only ever
	 * persisted once you happened to click "New chat", which created the second.
	 * Unlike create(), this keeps whatever is already on screen: it is adopting
	 * the conversation in progress, not starting a new one.
	 */
	async function ensure(app) {
		if (app.currentConversationId) return app.currentConversationId;
		const response = await fetch("./api/conversations", { method: "POST" });
		if (!response.ok) return "";
		const conversation = await response.json();
		app.conversations.unshift(conversation);
		app.currentConversationId = conversation.id;
		return conversation.id;
	}

	function save(app) {
		if (!app.currentConversationId) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(
			() =>
				fetch(
					`./api/conversations/${encodeURIComponent(app.currentConversationId)}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							messages: app.messages.map((message) => ({
								id: message.id || message.key,
								role: message.type === "user" ? "user" : "assistant",
								text: message.text || "",
								createdAt: new Date().toISOString(),
								metadata: {
									kind: message.kind,
									state: message.state,
									metrics: message.metrics,
								},
							})),
						}),
					},
				),
			250,
		);
	}
	/**
	 * Remove a conversation. Deleting the open one clears the transcript and
	 * falls through to whatever is left, so the console is never left showing
	 * messages that belong to a conversation that no longer exists.
	 */
	async function remove(app, conversation) {
		const response = await fetch(
			`./api/conversations/${encodeURIComponent(conversation.id)}`,
			{ method: "DELETE" },
		);
		if (!response.ok && response.status !== 404) return false;
		app.conversations = app.conversations.filter(
			(entry) => entry.id !== conversation.id,
		);
		if (app.currentConversationId === conversation.id) {
			const next = app.conversations[0];
			app.currentConversationId = next ? next.id : "";
			if (next) select(app, next);
			else app.messages = [];
		}
		return true;
	}

	function select(app, conversation) {
		app.currentConversationId = conversation.id;
		app.messages = conversation.messages.map((message) => ({
			id: message.id,
			type: message.role === "user" ? "user" : "assistant",
			text: message.text,
			...message.metadata,
		}));
		app.historyOpen = false;
	}
	globalScope.RemindMeConversations = { load, create, ensure, save, select, remove };
})(window);
