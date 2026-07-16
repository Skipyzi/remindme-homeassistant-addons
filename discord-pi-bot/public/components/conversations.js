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
	globalScope.RemindMeConversations = { load, create, save, select };
})(window);
