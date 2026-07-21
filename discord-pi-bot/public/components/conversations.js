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

	/** Update fields on a conversation and return the server's copy. */
	async function patch(id, values) {
		try {
			const response = await fetch(
				`./api/conversations/${encodeURIComponent(id)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(values),
				},
			);
			return response.ok ? await response.json() : null;
		} catch {
			return null;
		}
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
								/*
								 * Everything a timeline row needs to be itself again.
								 * Only kind, state and metrics used to survive, so a
								 * reopened conversation showed rows that knew they
								 * were tool calls but had lost the tool's name, its
								 * request and its result — a disclosure labelled
								 * "Tool" wrapped around nothing.
								 *
								 * `expanded` is deliberately not kept: a reopened
								 * conversation should read as a summary, and the
								 * rows open on click as they always did.
								 */
								metadata: {
									kind: message.kind,
									state: message.state,
									metrics: message.metrics,
									key: message.key,
									phaseId: message.phaseId,
									name: message.name,
									arguments: message.arguments,
									result: message.result,
									items: message.items,
									cards: message.cards,
									artifact: message.artifact,
								},
							})),
						}),
					},
				)
					.then((response) => (response.ok ? response.json() : null))
					.then((saved) => {
						if (!saved) return;
						/*
						 * Fold the server's copy back into the sidebar. Without
						 * this the cached entry kept its placeholder title and an
						 * empty message list forever, so the sidebar never showed
						 * the auto-generated name — and selecting that entry
						 * overwrote the live transcript with nothing.
						 */
						const cached = app.conversations.find(
							(entry) => entry.id === saved.id,
						);
						if (cached) Object.assign(cached, saved);
					})
					.catch(() => {}),
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

	/**
	 * Rebuild the transcript from a stored conversation.
	 *
	 * `type` and `kind` are not two names for one thing: the row is styled
	 * by whichever it has, and a `type` wins. Stamping "assistant" onto
	 * every non-user row therefore dressed restored tool and thinking rows
	 * as console replies — a bubble drawn around a disclosure that was
	 * still rendering itself as a tool call inside it.
	 *
	 * A row that knows its kind already knows what it is.
	 */
	function toMessages(conversation) {
		return (conversation.messages || []).map((message) => {
			const metadata = message.metadata || {};
			const restored = { id: message.id, text: message.text, ...metadata };
			if (message.role === "user") restored.type = "user";
			else if (!metadata.kind) restored.type = "assistant";
			/*
			 * Explicitly false, never absent. `:open` on a <details> is left
			 * untouched when its expression is undefined, and Alpine reuses
			 * DOM nodes between renders — so a row restored into an element
			 * that had been open stayed open, which is how a reopened
			 * conversation came back with every disclosure hanging out.
			 */
			restored.expanded = false;
			return restored;
		});
	}

	/**
	 * Open a conversation.
	 *
	 * Selecting the one already open is a no-op: it used to reload from the
	 * cached copy, and while a chat is in progress that copy is behind, so
	 * clicking the highlighted row wiped the transcript on screen. Switching
	 * to a different conversation refetches rather than trusting the cache,
	 * for the same reason.
	 */
	async function select(app, conversation) {
		app.historyOpen = false;
		if (conversation.id === app.currentConversationId) return;
		let fresh = conversation;
		try {
			const response = await fetch("./api/conversations");
			if (response.ok) {
				const all = await response.json();
				app.conversations = all;
				fresh = all.find((entry) => entry.id === conversation.id) || conversation;
			}
		} catch {
			/* Offline: the cached copy is all there is. */
		}
		app.currentConversationId = fresh.id;
		app.messages = toMessages(fresh);
	}
	globalScope.RemindMeConversations = { load, create, ensure, patch, save, select, remove };
})(window);
