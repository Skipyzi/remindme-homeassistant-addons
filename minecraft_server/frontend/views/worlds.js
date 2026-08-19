// Worlds: create, switch, clone, import, export, archive, trash and restore.

import {
  api, url, h, card, table, bytes, datetime, ago, run, toast, confirmAction, clear, titleCase,
} from '../lib.js';

export async function render(ctx) {
  const host = h('div', { class: 'stack' });

  const reload = async () => {
    const [data, trash] = await Promise.all([api('api/worlds'), api('api/worlds/trash')]);
    clear(host);
    host.append(
      card('Worlds', h('div', { class: 'card-actions' },
        h('button', { class: 'btn btn-small', onclick: () => reload() }, 'Refresh')),
        h('p', { class: 'muted' },
          'The Overworld, the Nether and the End are managed together as one world set. Switching worlds stops the server, changes the world container and starts it again, rolling back automatically if the new world fails to start.'),
        worldTable(data.worlds || [], data.active, reload, ctx)),
      card('Create a world', null, createForm(reload)),
      card('Import a world archive', null, importForm(reload)),
      card('Trash', null,
        h('p', { class: 'muted' },
          'Deleted worlds are moved here first. Permanent deletion is a separate, confirmed step.'),
        trashTable(trash.entries || [], reload)),
    );
  };

  await reload();
  return { element: host };
}

function worldTable(worlds, active, reload, ctx) {
  const rows = worlds.map((world) => {
    const dims = Object.entries(world.dimension_sizes || {})
      .filter(([, size]) => size > 0)
      .map(([dim, size]) => `${dim.replace('world_', '') || 'overworld'} ${bytes(size)}`)
      .join(' · ');

    return [
      h('div', {},
        h('strong', {}, world.name || world.id),
        world.active ? h('span', { class: 'pill pill-running', style: 'margin-left:.4rem' }, 'active') : null,
        world.archived ? h('span', { class: 'tag', style: 'margin-left:.4rem' }, 'archived') : null,
        h('div', { class: 'muted mono' }, world.id),
        world.notes ? h('div', { class: 'muted' }, world.notes) : null),
      h('div', {},
        h('div', {}, bytes(world.size_bytes)),
        dims ? h('div', { class: 'muted' }, dims) : null,
        world.size_updated_at ? h('div', { class: 'muted' }, `measured ${ago(world.size_updated_at)}`) : null),
      h('div', {},
        h('div', {}, world.seed ? h('span', { class: 'mono' }, world.seed) : h('span', { class: 'muted' }, 'random')),
        h('div', { class: 'muted' }, `${titleCase(world.source || 'unknown')} · ${world.generation_status}`),
        world.generated_radius
          ? h('div', { class: 'muted' }, `generated radius ${world.generated_radius} blocks`
            + (world.border_radius ? ` · border ${world.border_radius}` : ''))
          : null),
      h('div', {},
        h('div', {}, world.last_played_at ? ago(world.last_played_at) : 'never'),
        h('div', { class: 'muted' },
          world.backup_count
            ? `${world.backup_count} backup(s), last ${ago(world.last_backup_at)}`
            : 'no backups')),
      h('div', { class: 'card-actions' },
        world.active ? null : h('button', {
          class: 'btn btn-small btn-primary',
          onclick: async (ev) => {
            const backupBox = h('input', { type: 'checkbox' });
            backupBox.checked = true;
            const answer = await confirmAction({
              title: `Switch to ${world.name || world.id}?`,
              body: h('div', {},
                h('label', { class: 'inline' }, backupBox, h('span', {}, 'Back up the current world first'))),
              consequences: [
                'Minecraft is stopped',
                'the active world is switched - no data moves',
                'the server is started again and switched back automatically if it fails',
              ],
              recoverable: 'Recoverable: switching back is the same operation.',
              confirmLabel: 'Switch world',
              danger: false,
            });
            if (!answer.confirmed) return;
            await run(ev.target, async () => {
              const result = await api(`api/worlds/${encodeURIComponent(world.id)}/activate`, {
                method: 'POST', body: { backup: backupBox.checked },
              });
              toast(result.rolled_back
                ? 'The new world failed to start; rolled back.'
                : `Now running ${world.name || world.id}.`, result.rolled_back ? 'warn' : 'ok', 9000);
              await ctx.refreshStatus();
              await reload();
            });
          },
        }, 'Activate'),
        h('button', {
          class: 'btn btn-small',
          onclick: async (ev) => {
            const name = prompt(`Clone ${world.id} as:`, `${world.id}-copy`);
            if (!name) return;
            await run(ev.target, async () => {
              await api(`api/worlds/${encodeURIComponent(world.id)}/clone`, { method: 'POST', body: { name } });
              toast('World cloned.', 'ok');
              await reload();
            });
          },
        }, 'Clone'),
        h('a', {
          class: 'btn btn-small',
          href: url(`api/worlds/${encodeURIComponent(world.id)}/export`),
        }, 'Export'),
        h('button', {
          class: 'btn btn-small',
          onclick: async (ev) => {
            const name = prompt('New display name:', world.name || world.id);
            if (!name) return;
            await run(ev.target, async () => {
              await api(`api/worlds/${encodeURIComponent(world.id)}/rename`, { method: 'POST', body: { name } });
              await reload();
            });
          },
        }, 'Rename'),
        h('button', {
          class: 'btn btn-small',
          onclick: (ev) => run(ev.target, async () => {
            await api(`api/worlds/${encodeURIComponent(world.id)}/archive`, {
              method: 'POST', body: { archived: !world.archived },
            });
            await reload();
          }),
        }, world.archived ? 'Unarchive' : 'Archive'),
        world.active ? null : h('button', {
          class: 'btn btn-small btn-danger',
          onclick: async (ev) => {
            const answer = await confirmAction({
              title: `Move ${world.id} to the trash?`,
              body: 'The world is moved to /data/trash. Nothing is erased in this step.',
              recoverable: 'Recoverable: restore it from the Trash section on this page.',
              typeName: world.id,
              confirmLabel: 'Move to trash',
            });
            if (!answer.confirmed) return;
            await run(ev.target, async () => {
              await api(`api/worlds/${encodeURIComponent(world.id)}?confirm=${encodeURIComponent(answer.phrase)}`, {
                method: 'DELETE',
              });
              toast('Moved to the trash.', 'ok');
              await reload();
            });
          },
        }, 'Delete')),
    ];
  });

  return table(['World', 'Size', 'Seed and generation', 'Last played', 'Actions'], rows);
}

function createForm(reload) {
  const name = h('input', { type: 'text', placeholder: 'survival' });
  const seed = h('input', { type: 'text', placeholder: 'leave empty for a random seed' });
  const notes = h('input', { type: 'text', placeholder: 'optional note' });

  return h('div', {},
    h('div', { class: 'form-grid' },
      h('label', {}, h('span', { class: 'label-text' }, 'Name'), name),
      h('label', {}, h('span', { class: 'label-text' }, 'Seed'), seed),
      h('label', {}, h('span', { class: 'label-text' }, 'Notes'), notes)),
    h('p', { class: 'muted' },
      'The world is created empty. Minecraft generates the terrain the first time you activate and start it.'),
    h('button', {
      class: 'btn btn-primary',
      onclick: (ev) => {
        if (!name.value.trim()) {
          toast('A name is required.', 'warn');
          return;
        }
        return run(ev.target, async () => {
          await api('api/worlds', {
            method: 'POST',
            body: { name: name.value.trim(), seed: seed.value.trim(), notes: notes.value.trim() },
          });
          toast('World created.', 'ok');
          name.value = '';
          seed.value = '';
          notes.value = '';
          await reload();
        });
      },
    }, 'Create world'));
}

function importForm(reload) {
  const file = h('input', { type: 'file', accept: '.zip' });
  const name = h('input', { type: 'text', placeholder: 'world name (defaults to the file name)' });
  const progress = h('p', { class: 'muted' });

  return h('div', {},
    h('div', { class: 'form-grid' },
      h('label', {}, h('span', { class: 'label-text' }, 'ZIP archive'), file),
      h('label', {}, h('span', { class: 'label-text' }, 'Name'), name)),
    h('p', { class: 'muted' },
      'Archives are extracted into a staging directory and validated before anything is installed. Entries with absolute paths, traversal segments, symbolic links or implausible compression ratios are rejected.'),
    progress,
    h('button', {
      class: 'btn btn-primary',
      onclick: async (ev) => {
        if (!file.files || !file.files.length) {
          toast('Choose a ZIP file first.', 'warn');
          return;
        }
        const form = new FormData();
        form.append('file', file.files[0]);
        if (name.value.trim()) form.append('name', name.value.trim());
        progress.textContent = 'uploading…';
        const button = ev.target;
        button.disabled = true;
        try {
          const res = await fetch(url('api/worlds/import'), {
            method: 'POST', headers: { 'X-Minecraft-Addon': '1' }, body: form,
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || res.statusText);
          progress.textContent = '';
          toast(`Imported ${data.world_id} (${data.files} files, ${bytes(data.bytes)})`, 'ok', 9000);
          for (const warning of data.warnings || []) toast(warning, 'warn', 12000);
          file.value = '';
          name.value = '';
          await reload();
        } catch (err) {
          progress.textContent = '';
          toast(err.message, 'error', 14000);
        } finally {
          button.disabled = false;
        }
      },
    }, 'Import archive'));
}

function trashTable(entries, reload) {
  if (!entries.length) return h('p', { class: 'empty' }, 'The trash is empty.');
  const rows = entries.map((entry) => [
    h('div', {}, h('strong', {}, entry.world_id), h('div', { class: 'muted mono' }, entry.name)),
    datetime(entry.deleted_at),
    bytes(entry.size_bytes),
    h('div', { class: 'card-actions' },
      h('button', {
        class: 'btn btn-small',
        onclick: (ev) => run(ev.target, async () => {
          await api(`api/worlds/trash/${encodeURIComponent(entry.name)}/restore`, { method: 'POST' });
          toast('World restored.', 'ok');
          await reload();
        }),
      }, 'Restore'),
      h('button', {
        class: 'btn btn-small btn-danger',
        onclick: async (ev) => {
          const answer = await confirmAction({
            title: `Permanently delete ${entry.name}?`,
            body: 'This erases the world data from disk. Existing backups are not affected, but if there are none, the world is gone for good.',
            typeName: entry.name,
            wirePhrase: 'DELETE-PERMANENTLY',
            confirmLabel: 'Delete permanently',
          });
          if (!answer.confirmed) return;
          await run(ev.target, async () => {
            await api(`api/worlds/trash/${encodeURIComponent(entry.name)}?confirm=${encodeURIComponent(answer.phrase)}`, {
              method: 'DELETE',
            });
            toast('Deleted permanently.', 'ok');
            await reload();
          });
        },
      }, 'Delete permanently')),
  ]);
  return table(['World', 'Deleted', 'Size', 'Actions'], rows);
}
