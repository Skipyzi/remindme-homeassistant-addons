// Backups: create, inspect, verify, restore and prune.

import {
  api, h, card, table, bar, bytes, datetime, ago, duration, run, toast, confirmAction, clear, titleCase,
} from '../lib.js';

export async function render(ctx) {
  const host = h('div', { class: 'stack' });
  const progressHost = h('div', {});

  const reload = async () => {
    const [list, health] = await Promise.all([api('api/backups'), api('api/backups/health')]);
    clear(host);
    host.append(
      healthCard(health, reload),
      progressHost,
      card('Create a backup', null, createForm(reload)),
      card(`Backups (${(list.backups || []).length})`,
        h('div', { class: 'card-actions' },
          list.current && list.current.running && list.current.cancellable
            ? h('button', {
              class: 'btn btn-small btn-danger',
              onclick: (ev) => run(ev.target, async () => {
                await api('api/backups/cancel', { method: 'POST' });
                toast('Cancellation requested.', 'ok');
              }),
            }, 'Cancel running operation')
            : null,
          h('button', { class: 'btn btn-small', onclick: () => reload() }, 'Refresh')),
        list.current && list.current.running
          ? h('p', { class: 'muted' }, `Running: ${list.current.description}`)
          : null,
        backupTable(list.backups || [], reload, ctx)),
    );
  };

  await reload();

  const unsubscribe = ctx.subscribe((event) => {
    if (event.type === 'backup_progress' || event.type === 'restore_progress') {
      clear(progressHost);
      const data = event.data || {};
      progressHost.append(card(event.type === 'backup_progress' ? 'Backup in progress' : 'Restore in progress', null,
        bar(data.percent),
        h('p', { class: 'muted' }, `${Math.round(data.percent || 0)}% — ${data.message || ''}`)));
      if ((data.percent || 0) >= 100) setTimeout(() => { clear(progressHost); reload(); }, 1500);
    }
    if (event.type === 'backups_changed') reload();
  });

  return { element: host, cleanup: unsubscribe };
}

function healthCard(health, reload) {
  const status = health.available
    ? h('span', { class: 'pill pill-running' }, 'available')
    : h('span', { class: 'pill pill-crashed' }, 'unavailable');

  return card('Backup repository',
    h('div', { class: 'card-actions' },
      h('button', {
        class: 'btn btn-small',
        onclick: (ev) => run(ev.target, async () => {
          await api('api/backups/verify', { method: 'POST', body: {} });
          toast('Repository structure verified.', 'ok');
          await reload();
        }),
      }, 'Verify structure'),
      h('button', {
        class: 'btn btn-small',
        onclick: (ev) => run(ev.target, async () => {
          await api('api/backups/verify', { method: 'POST', body: { read_subset: '5%' } });
          toast('Deep verification finished.', 'ok');
          await reload();
        }),
      }, 'Deep verify (5% of data)'),
      h('button', {
        class: 'btn btn-small',
        onclick: (ev) => run(ev.target, async () => {
          await api('api/backups/retention', { method: 'POST' });
          toast('Retention rules applied.', 'ok');
          await reload();
        }),
      }, 'Apply retention now')),
    h('div', { class: 'row' }, status,
      h('span', { class: 'muted' }, health.restic_version || ''),
      h('span', { class: 'spacer' })),
    h('div', { class: 'grid metrics', style: 'margin-top:.6rem' },
      h('div', { class: 'metric' },
        h('div', { class: 'label' }, 'Repository size'),
        h('div', { class: 'value' }, bytes(health.size_bytes))),
      h('div', { class: 'metric' },
        h('div', { class: 'label' }, 'Snapshots'),
        h('div', { class: 'value' }, String(health.snapshot_count || 0))),
      h('div', { class: 'metric' },
        h('div', { class: 'label' }, 'Last backup'),
        h('div', { class: 'value' }, health.last_backup_at ? ago(health.last_backup_at) : 'never'),
        h('div', { class: 'sub' }, health.last_duration ? `took ${duration(health.last_duration / 1000)}` : '')),
      h('div', { class: 'metric' },
        h('div', { class: 'label' }, 'Last verification'),
        h('div', { class: 'value' }, health.last_check ? ago(health.last_check) : 'never'))),
    health.error ? h('p', { class: 'banner error', style: 'margin-top:.6rem' }, health.error) : null,
    h('p', { class: 'muted', style: 'margin-top:.5rem' },
      'Backups are incremental and deduplicated: only changed data blocks are stored. The repository key lives in /data/secrets/restic.pass — copy it somewhere safe, because without it the repository cannot be read.'));
}

function createForm(reload) {
  const label = h('input', { type: 'text', placeholder: 'optional label' });
  const notes = h('input', { type: 'text', placeholder: 'optional note' });
  const offline = h('input', { type: 'checkbox' });
  const allowLive = h('input', { type: 'checkbox' });

  return h('div', {},
    h('div', { class: 'form-grid' },
      h('label', {}, h('span', { class: 'label-text' }, 'Label'), label),
      h('label', {}, h('span', { class: 'label-text' }, 'Notes'), notes)),
    h('label', { class: 'inline' }, offline,
      h('span', {}, 'Stop the server for a fully clean backup (it is started again afterwards)')),
    h('label', { class: 'inline' }, allowLive,
      h('span', {}, 'Allow a crash-consistent backup if the world cannot be flushed')),
    h('p', { class: 'muted' },
      'While the server runs, the add-on disables saving, flushes the world, takes a hardlink snapshot and re-enables saving — usually well under a second — and only then compresses and deduplicates in the background.'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (ev) => run(ev.target, async () => {
        const record = await api('api/backups', {
          method: 'POST',
          body: {
            kind: 'manual', label: label.value.trim(), notes: notes.value.trim(),
            offline: offline.checked, allow_live: allowLive.checked,
          },
        });
        toast(`Backup ${record.status} (${bytes(record.added_bytes)} new data)`, 'ok', 9000);
        label.value = '';
        notes.value = '';
        await reload();
      }),
    }, 'Back up now'));
}

function backupTable(records, reload, ctx) {
  const rows = records.map((record) => [
    h('div', {},
      h('strong', {}, record.label || titleCase(record.kind)),
      h('div', { class: 'muted' }, datetime(record.created_at)),
      h('div', { class: 'muted mono' }, record.snapshot_id ? record.snapshot_id.slice(0, 12) : '—'),
      record.notes ? h('div', { class: 'muted' }, record.notes) : null),
    h('div', {},
      h('div', {}, record.world_id),
      h('div', { class: 'muted' }, titleCase(record.kind))),
    h('div', {},
      h('div', {}, bytes(record.size_bytes)),
      h('div', { class: 'muted' }, `+${bytes(record.added_bytes)} new`),
      h('div', { class: 'muted' }, record.duration_ms ? duration(record.duration_ms / 1000) : '')),
    h('div', {},
      statusPill(record),
      h('div', { class: 'muted' }, consistencyText(record.consistency)),
      record.verified ? h('span', { class: 'tag' }, 'verified') : null,
      record.exists_in_repository === false && record.status === 'complete'
        ? h('span', { class: 'pill pill-warn' }, 'missing in repository') : null),
    h('div', { class: 'card-actions' },
      h('button', {
        class: 'btn btn-small',
        onclick: (ev) => run(ev.target, async () => {
          const preview = await api(`api/backups/${encodeURIComponent(record.id)}/preview`);
          await confirmAction({
            title: 'Restore preview',
            body: h('div', {},
              h('p', { class: 'muted' }, `${preview.entries.length} entries${preview.truncated ? ' (truncated)' : ''}, ${bytes(preview.total_bytes)} total`),
              h('div', { class: 'console', style: 'height:220px' },
                preview.entries.map((entry) => h('div', {}, `${entry.type === 'dir' ? 'd' : '-'} ${entry.path}`)))),
            phrase: null, confirmLabel: 'Close', danger: false,
          });
        }),
      }, 'Preview'),
      h('button', {
        class: 'btn btn-small btn-primary',
        disabled: record.status !== 'complete',
        onclick: async (ev) => {
          const skipBox = h('input', { type: 'checkbox' });
          const answer = await confirmAction({
            title: `Restore ${record.label || record.kind}?`,
            body: h('div', {},
              h('p', {}, `The server is stopped, the current world is backed up, and this snapshot of ${record.world_id} is restored. If the restored world fails to start, the previous world is put back automatically.`),
              h('label', { class: 'inline' }, skipBox,
                h('span', {}, 'Skip the safety backup (not recommended)'))),
            phrase: 'RESTORE',
            confirmLabel: 'Restore',
          });
          if (!answer.confirmed) return;
          await run(ev.target, async () => {
            const result = await api(`api/backups/${encodeURIComponent(record.id)}/restore`, {
              method: 'POST',
              body: { skip_safety_backup: skipBox.checked, confirm: answer.phrase },
            });
            toast(result.rolled_back
              ? 'Restore failed and was rolled back.'
              : 'Restore complete.', result.rolled_back ? 'warn' : 'ok', 10000);
            await ctx.refreshStatus();
            await reload();
          });
        },
      }, 'Restore'),
      h('button', {
        class: 'btn btn-small',
        onclick: async (ev) => {
          const label = prompt('Label:', record.label || '');
          if (label === null) return;
          await run(ev.target, async () => {
            await api(`api/backups/${encodeURIComponent(record.id)}/label`, {
              method: 'POST', body: { label, notes: record.notes || '' },
            });
            await reload();
          });
        },
      }, 'Label'),
      h('button', {
        class: 'btn btn-small btn-danger',
        onclick: async (ev) => {
          const answer = await confirmAction({
            title: 'Delete this backup?',
            body: 'The snapshot is forgotten and unreferenced data is pruned from the repository.',
            phrase: 'DELETE',
            confirmLabel: 'Delete backup',
          });
          if (!answer.confirmed) return;
          await run(ev.target, async () => {
            await api(`api/backups/${encodeURIComponent(record.id)}?confirm=${encodeURIComponent(answer.phrase)}`, {
              method: 'DELETE',
            });
            toast('Backup deleted.', 'ok');
            await reload();
          });
        },
      }, 'Delete')),
  ]);

  return table(['Backup', 'World', 'Size', 'State', 'Actions'], rows);
}

function statusPill(record) {
  const tone = {
    complete: 'pill-running', running: 'pill-busy', failed: 'pill-crashed', cancelled: 'pill-stopped',
  }[record.status] || 'pill-unknown';
  return h('span', { class: `pill ${tone}` }, record.status);
}

function consistencyText(consistency) {
  switch (consistency) {
    case 'clean': return 'server was stopped';
    case 'flushed': return 'flushed before snapshot';
    case 'live': return 'crash-consistent only';
    default: return '';
  }
}
