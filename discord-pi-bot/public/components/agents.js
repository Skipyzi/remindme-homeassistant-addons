window.RemindMeAgents = {
	async load(app) {
		try {
			const response = await fetch('./api/agents');
			if (!response.ok) throw new Error('Unable to load assistant backends');
			const settings = await response.json();
			app.agentBackend = settings.backend;
			app.agentModels = settings.models;
			app.agentBackends = settings.backends;
			app.agentModel = settings.models[settings.backend] || '';
			app.agentDefaultModel = settings.defaultModel || '';
			const pending = await fetch('./api/confirmations');
			if (pending.ok) app.agentConfirmations = await pending.json();
			app.agentError = '';
		} catch (error) { app.agentError = error.message; }
	},
	async select(app) { app.agentModel = app.agentModels[app.agentBackend] || ''; await this.save(app); },
	async save(app) {
		app.agentError = '';
		try {
			const response = await fetch('./api/agents', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ backend: app.agentBackend, model: app.agentModel }) });
			const settings = await response.json();
			if (!response.ok) throw new Error(settings.error || 'Unable to save backend');
			app.agentModels = settings.models;
			app.refreshStatus();
		} catch (error) { app.agentError = error.message; }
	},
	async confirm(app, confirm) {
		const message = { confirm, text: '' };
		await app.confirmAction(message);
		app.agentConfirmationResult = message.text;
		await this.load(app);
	},
};
