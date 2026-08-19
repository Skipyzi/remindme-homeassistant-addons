// Live console with a command input.

import {
  api, h, card, run, toast, clear, append,
} from '../lib.js';

export async function render(ctx) {
  const output = h('div', { class: 'console' });
  const input = h('input', {
    type: 'text', placeholder: 'command, without the leading slash (for example: list)',
    autocomplete: 'off', spellcheck: 'false',
  });

  const history = [];
  let historyIndex = -1;

  const send = async () => {
    const command = input.value.trim();
    if (!command) return;
    history.push(command);
    historyIndex = history.length;
    input.value = '';
    try {
      await api('api/server/command', { method: 'POST', body: { command } });
    } catch (err) {
      toast(err.message, 'error', 10000);
    }
  };

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      send();
    } else if (ev.key === 'ArrowUp' && history.length) {
      historyIndex = Math.max(0, historyIndex - 1);
      input.value = history[historyIndex] || '';
    } else if (ev.key === 'ArrowDown' && history.length) {
      historyIndex = Math.min(history.length, historyIndex + 1);
      input.value = history[historyIndex] || '';
    }
  });

  const form = h('div', { class: 'console-form' },
    input,
    h('button', {
      class: 'btn btn-primary',
      onclick: (ev) => run(ev.target, send),
    }, 'Send'));

  const element = h('div', { class: 'stack' },
    card('Console',
      h('div', { class: 'card-actions' },
        h('button', {
          class: 'btn btn-small',
          onclick: () => { clear(output); toast('cleared the local view only', 'info', 3000); },
        }, 'Clear view'),
        h('button', {
          class: 'btn btn-small',
          onclick: (ev) => run(ev.target, () => api('api/server/command', { method: 'POST', body: { command: 'list' } })),
        }, 'list'),
        h('button', {
          class: 'btn btn-small',
          onclick: (ev) => run(ev.target, () => api('api/server/command', { method: 'POST', body: { command: 'tps' } })),
        }, 'tps'),
        h('button', {
          class: 'btn btn-small',
          onclick: (ev) => run(ev.target, () => api('api/server/command', { method: 'POST', body: { command: 'save-all' } })),
        }, 'save-all')),
      output,
      form,
      h('p', { class: 'muted' },
        'Commands go to the server’s standard input, exactly as if typed on a console. Every command is written to the audit log.')),
  );

  const initial = await api('api/console?limit=500');
  let lastSeq = 0;
  for (const line of initial.lines || []) {
    appendLine(output, line);
    lastSeq = line.seq;
  }
  output.scrollTop = output.scrollHeight;

  const unsubscribe = ctx.subscribe((event) => {
    if (event.type !== 'server_log') return;
    const line = event.data;
    if (!line || line.seq <= lastSeq) return;
    lastSeq = line.seq;
    const pinned = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    appendLine(output, line);
    if (pinned) output.scrollTop = output.scrollHeight;
  });

  return { element, cleanup: unsubscribe };
}

function appendLine(host, line) {
  append(host, h('div', { class: `l-${line.stream || 'stdout'}` }, line.text));
  while (host.childElementCount > 2000) host.removeChild(host.firstChild);
}
