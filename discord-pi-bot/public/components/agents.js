(function (scope) {
 let catalogRequest = 0;
 const api = async (path, body, method = 'POST') => {
  const response = await fetch(`./api/agents${path}`, body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Assistant settings could not be loaded');
  return data;
 };
 const sourceId = (selection, sources) => selection.source === 'native' ? 'native' : sources.find(s => s.source === 'endpoint' && s.endpointId === selection.endpointId)?.id || sources.find(s => s.source === 'endpoint')?.id || '';
 scope.RemindMeAgents = {
  async load(app) {
   const id = app.currentConversationId;
   try {
    const settings = await api(id ? `?conversationId=${encodeURIComponent(id)}` : '');
    if (id !== app.currentConversationId) return;
    app.agentBackend = settings.selection.backend;
    app.agentModel = settings.selection.model || settings.effectiveModel || '';
    await scope.RemindMeEndpoints.load(app);
    app.agentSelection = { ...settings.selection, ...(settings.selection.source === 'endpoint' && !['codex','claude'].includes(settings.selection.backend) ? { endpointId: settings.selection.endpointId ?? app.endpointActiveId } : {}) };
    app.agentModels = settings.models;
    app.agentBackends = settings.backends;
    app.agentOrigin = settings.origin || null;
    app.agentCurrent = settings.current || null;
    app.agentDefaultModel = settings.defaultModel || '';
    await this.catalog(app, true);
    const pending = await fetch('./api/confirmations');
    if (pending.ok) app.agentConfirmations = await pending.json();
   } catch (error) { app.agentError = error.message; }
  },
  async catalog(app, restore = false) {
   const request = ++catalogRequest;
   app.agentLoading = true; app.agentError = '';
   const previousSource = app.agentSources.find(s => s.id === app.agentSource);
   const selection = restore ? app.agentSelection : { source: previousSource?.source || 'endpoint', endpointId: previousSource?.endpointId ?? (['codex','claude'].includes(app.agentBackend) ? undefined : app.endpointActiveId) };
   const query = new URLSearchParams({ backend: app.agentBackend, source: selection.source || 'endpoint' });
   if (selection.endpointId !== undefined) query.set('endpointId', selection.endpointId);
   try {
    const catalog = await api(`/models?${query}`);
    if (request !== catalogRequest) return;
    app.agentSources = catalog.sources;
    app.agentChoices = catalog.models;
    app.agentSource = sourceId(selection, catalog.sources);
    if (!restore || !app.agentModel) app.agentModel = catalog.models.some(m => m.id === app.agentModel) ? app.agentModel : catalog.models[0]?.id || '';
    if (catalog.providers?.length) app.agentPiProviders = catalog.providers;
    if (!app.agentChoices.some(m => m.id === app.agentModel) && app.agentModel) app.agentChoices = [{ id: app.agentModel, name: `${app.agentModel} (saved model)` }, ...app.agentChoices];
   } catch (error) { if (request === catalogRequest) { app.agentChoices = []; app.agentError = error.message; } }
   finally { if (request === catalogRequest) app.agentLoading = false; }
  },
  async select(app) { app.agentModel = ''; app.agentSource = ''; app.agentSources = []; await this.catalog(app); },
  async source(app) { app.agentModel = ''; await this.catalog(app); },
  async save(app) {
   if (app.busy || app.agentLoading) return;
   app.agentError = '';
   try {
    const source = app.agentSources.find(s => s.id === app.agentSource);
    if (!source || !app.agentModel) throw new Error('Choose an account and model first.');
    await scope.RemindMeConversations.ensure(app);
    const data = await api(`/conversations/${encodeURIComponent(app.currentConversationId)}`, { backend: app.agentBackend, model: app.agentModel, source: source.source, ...(source.endpointId !== undefined ? { endpointId: source.endpointId } : {}) }, 'PUT');
    app.agentSelection = data.selection;
    app.agentPickerOpen = false;
    app.agentSaved = 'Saved for this conversation.';
    await app.refreshStatus();
   } catch (error) { app.agentError = error.message; }
  },
  async open(app) { app.agentPickerOpen = !app.agentPickerOpen; if (app.agentPickerOpen) { await scope.RemindMeEndpoints.load(app); await this.load(app); } },
  label(conversation) { const origin = conversation.agent?.origin; return origin ? origin.label : (conversation.messages?.length ? 'Earlier provider not recorded' : 'Assistant chosen on first message'); },
  async confirm(app, confirm) { const message = { confirm, text: '' }; await app.confirmAction(message); app.agentConfirmationResult = message.text; await this.load(app); },
 };
})(window);
