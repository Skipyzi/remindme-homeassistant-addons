(function exposeEndpoints(globalScope) {
	/**
	 * Client for the inference-endpoint list.
	 *
	 * The API key is write-only end to end: a saved endpoint reports only
	 * `hasKey`, never the key, so the field starts blank and is sent only
	 * when the user types a new one. Leaving it blank on an existing
	 * endpoint keeps whatever key is already stored.
	 */

	async function load(app) {
		try {
			const response = await fetch("./api/endpoints");
			if (!response.ok) return;
			const config = await response.json();
			app.endpoints = config.endpoints || [];
			app.endpointActiveId = config.activeId || "";
		} catch {
			/* Offline: the panel just shows nothing to switch to. */
		}
	}

	/** A blank draft, or one seeded from an endpoint to edit it. */
	function edit(app, endpoint) {
		app.endpointError = "";
		app.endpointTest = null;
		app.endpointDraft = endpoint
			? {
					id: endpoint.id,
					name: endpoint.name,
					url: endpoint.url,
					model: endpoint.model,
					openaiCompat: endpoint.openaiCompat,
					hasKey: endpoint.hasKey,
					apiKey: "", // never prefilled; blank means "keep the stored key"
				}
			: {
					id: "",
					name: "",
					url: "",
					model: "",
					openaiCompat: true,
					hasKey: false,
					apiKey: "",
				};
	}

	function cancel(app) {
		app.endpointDraft = null;
		app.endpointError = "";
		app.endpointTest = null;
	}

	function draftBody(draft) {
		const body = {
			name: draft.name,
			url: draft.url,
			model: draft.model,
			openaiCompat: draft.openaiCompat,
		};
		// Only send the key when the user actually typed one.
		if (draft.apiKey) body.apiKey = draft.apiKey;
		return body;
	}

	async function save(app) {
		const draft = app.endpointDraft;
		if (!draft) return;
		if (!draft.name.trim() || !draft.url.trim()) {
			app.endpointError = "A name and a URL are required.";
			return;
		}
		app.endpointBusy = true;
		app.endpointError = "";
		try {
			const editing = Boolean(draft.id);
			const response = await fetch(
				editing ? `./api/endpoints/${encodeURIComponent(draft.id)}` : "./api/endpoints",
				{
					method: editing ? "PATCH" : "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(draftBody(draft)),
				},
			);
			const data = await response.json();
			if (!response.ok) {
				app.endpointError = data.error || "Could not save the endpoint.";
				return;
			}
			await load(app);
			app.endpointDraft = null;
			app.endpointTest = null;
		} finally {
			app.endpointBusy = false;
		}
	}

	async function remove(app, endpoint) {
		if (!window.confirm(`Delete endpoint "${endpoint.name}"?`)) return;
		await fetch(`./api/endpoints/${encodeURIComponent(endpoint.id)}`, {
			method: "DELETE",
		});
		await load(app);
	}

	/** Switch the live endpoint; "" restores the built-in local model. */
	async function activate(app, id) {
		const response = await fetch("./api/endpoints/active", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: id || "" }),
		});
		if (!response.ok) return;
		const config = await response.json();
		app.endpointActiveId = config.activeId || "";
		// The badge and profiles change with the endpoint; refresh them.
		app.refreshStatus?.();
	}

	/**
	 * A live round trip against a saved endpoint. Saves any pending edits
	 * first, so the test hits exactly what would be used.
	 */
	async function test(app) {
		const draft = app.endpointDraft;
		if (!draft) return;
		app.endpointTest = null;
		if (draft.id || draft.name.trim()) await save(app);
		// save() clears the draft on success; find the endpoint just written.
		const target = app.endpoints.find(
			(endpoint) => endpoint.id === draft.id || endpoint.name === draft.name,
		);
		if (!target) return;
		app.endpointBusy = true;
		try {
			const response = await fetch(
				`./api/endpoints/${encodeURIComponent(target.id)}/test`,
				{ method: "POST" },
			);
			app.endpointTest = await response.json();
		} catch (error) {
			app.endpointTest = { ok: false, error: String(error) };
		} finally {
			app.endpointBusy = false;
		}
	}

	globalScope.RemindMeEndpoints = {
		load,
		edit,
		cancel,
		save,
		remove,
		activate,
		test,
	};
})(window);
