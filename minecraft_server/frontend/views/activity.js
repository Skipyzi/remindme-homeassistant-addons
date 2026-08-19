// Activity: the audit log and the recovery journal.

import {
  api, h, card, table, datetime, ago, titleCase, statePill, clear, run, append,
} from '../lib.js';

export async function render() {
  const host = h('div', { class: 'stack' });

  const reload = async () => {
    const [audit, journal] = await Promise.all([
      api('api/audit?limit=200'), api('api/journal?limit=50'),
    ]);
    clear(host);
    append(host, 
      card('Recovery journal',
        h('button', { class: 'btn btn-small', onclick: () => reload() }, 'Refresh'),
        h('p', { class: 'muted' },
          'Every multi-step operation records its phase before touching the filesystem. An entry stuck on "open" is what startup reconciliation cleans up.'),
        journalTable(journal.entries || [])),
      card('Audit log', null,
        h('p', { class: 'muted' },
          'Also written as plain text to /data/audit/audit.log, so it can be read with the Home Assistant file editor even if the controller will not start.'),
        auditTable(audit.entries || [])),
    );
  };

  await reload();
  return { element: host };
}

function journalTable(entries) {
  if (!entries.length) return h('p', { class: 'empty' }, 'No operations recorded yet.');
  return table(['Operation', 'Phase', 'Status', 'Started', 'Detail'],
    entries.map((entry) => [
      titleCase(entry.op),
      entry.phase,
      statePill(entry.status === 'done' ? 'running' : entry.status === 'open' ? 'starting' : 'crashed'),
      h('div', {}, datetime(entry.started_at), h('div', { class: 'muted' }, ago(entry.started_at))),
      h('div', {},
        entry.detail || '',
        entry.payload ? h('div', { class: 'muted mono' }, summarize(entry.payload)) : null),
    ]));
}

function summarize(payload) {
  return Object.entries(payload)
    .filter(([, value]) => value !== '' && value !== null && typeof value !== 'object')
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
}

function auditTable(entries) {
  if (!entries.length) return h('p', { class: 'empty' }, 'Nothing recorded yet.');
  return table(['When', 'Actor', 'Action', 'Target', 'Detail'],
    entries.map((entry) => [
      h('div', {}, ago(entry.time), h('div', { class: 'muted' }, datetime(entry.time))),
      entry.actor,
      h('span', {},
        entry.action,
        entry.result && entry.result !== 'ok'
          ? h('span', { class: 'pill pill-warn', style: 'margin-left:.3rem' }, entry.result)
          : null),
      entry.target || '',
      h('span', { class: 'mono' }, entry.detail || ''),
    ]));
}
