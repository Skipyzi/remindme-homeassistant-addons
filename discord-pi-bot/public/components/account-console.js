(function (scope) {
 let terminal, poll, written = '', sessionId = '';
 const request = async (action = '', body) => {
  const response = await fetch(`./api/agents/auth${action}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Sign-in console failed');
  return data;
 };
 function render(app, data) {
  app.authConsole = data;
  if (data.running) app.authConsoleBackend = data.backend;
  const output = data.output || '';
  if (data.id !== sessionId || !output.startsWith(written)) { terminal?.reset(); written = ''; sessionId = data.id; }
  terminal?.write(output.slice(written.length)); written = output;
 }
 async function update(app) {
  try { render(app, await request()); }
  catch (error) { app.authConsoleError = error.message; }
  if (app.authConsole.running) poll = setTimeout(() => update(app), app.authConsoleOpen ? 700 : 2000);
 }
 scope.RemindMeAccountConsole = {
  async open(app, backend = app.agentBackend === 'harness' ? 'codex' : app.agentBackend) {
   app.agentPickerOpen = false; app.modelsOpen = false; app.authConsoleBackend = backend;
   app.authConsoleOpen = true; app.authConsoleError = ''; app.authConsoleInput = '';
   await new Promise(resolve => app.$nextTick(resolve));
   if (!terminal && scope.Terminal) {
    terminal = new scope.Terminal({ cols: 90, rows: 18, cursorBlink: true, convertEol: true, fontFamily: 'IBM Plex Mono, monospace', fontSize: 12, theme: { background: '#090b09', foreground: '#d5ddd5', cursor: '#b3c9b3' } });
    terminal.open(document.getElementById('account-terminal'));
    terminal.onData(data => { if (app.authConsole.running && ['codex', 'opencode'].includes(app.authConsole.backend)) void request('/input', { id: app.authConsole.id, input: data, raw: true }).catch(error => { app.authConsoleError = error.message; }); });
   }
   clearTimeout(poll); await update(app);
   try { const response = await fetch('./api/agents/models?backend=pi&source=native'); if (response.ok) { const data = await response.json(); app.agentPiProviders = data.providers || []; app.authConsoleProvider ||= app.agentPiProviders[0]?.id || ''; } } catch {}
  },
  async start(app) {
   if (app.authConsoleBusy) return;
   app.authConsoleBusy = true; app.authConsoleError = '';
   try { render(app, await request('/start', { backend: app.authConsoleBackend, provider: app.authConsoleProvider })); clearTimeout(poll); await update(app); }
   catch (error) { app.authConsoleError = error.message; }
   finally { app.authConsoleBusy = false; }
  },
  async input(app, value = app.authConsoleInput) {
   app.authConsoleInput = ''; app.authConsoleError = ''; app.authConsoleBusy = true;
   try { render(app, await request('/input', { id: app.authConsole.id, input: value })); }
   catch (error) { app.authConsoleError = error.message; }
   finally { app.authConsoleBusy = false; }
  },
  async key(app, input) { try { render(app, await request('/input', { id: app.authConsole.id, input, raw: true })); } catch (error) { app.authConsoleError = error.message; } },
  async cancel(app) { try { render(app, await request('/cancel', { id: app.authConsole.id })); } catch (error) { app.authConsoleError = error.message; } },
  async close(app) { app.authConsoleOpen = false; app.authConsoleInput = ''; await scope.RemindMeAgents.load(app); await scope.RemindMeProviders.load(app); },
 };
})(window);
