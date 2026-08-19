// Mods: search Modrinth, install curated packs, manage what is installed.
// Paper calls its content plugins, Babric calls it mods; the backend says which.

import {
  api, h, card, run, toast, confirmAction, clear, bytes, num, append,
} from '../lib.js';

export async function render(ctx) {
  const host = h('div', { class: 'stack' });
  const status = await api('api/mods');

  if (!status.supported) {
    append(host, card('Mods and plugins', null,
      h('p', { class: 'banner info' },
        'Plain Better than Adventure! has no mod loader. Switch to the "BTA with Babric" flavour in Settings to run the same game with mods, or to PaperMC for plugins.')));
    return { element: host };
  }

  const nounTitle = status.noun === 'plugin' ? 'Plugins' : 'Mods';
  const installedHost = h('div', {});
  const packsHost = h('div', {});
  const searchHost = h('div', {});

  const reload = async () => {
    const fresh = await api('api/mods');
    renderInstalled(installedHost, fresh, ctx, reload);
    renderPacks(packsHost, fresh, reload);
  };

  append(host,
    card(`Installed ${nounTitle.toLowerCase()}`,
      h('button', {
        class: 'btn btn-small',
        onclick: (ev) => run(ev.target, async () => {
          const { updates } = await api('api/mods/updates');
          if (!updates.length) {
            toast(`Every managed ${status.noun} is current.`, 'ok');
            return;
          }
          for (const update of updates) {
            await api('api/mods/install', { method: 'POST', body: { project: update.project } });
          }
          toast(`Updated ${updates.length} ${status.noun}${updates.length === 1 ? '' : 's'}. Restart to load.`, 'ok', 9000);
          await reload();
        }),
      }, 'Check for updates'),
      installedHost),
    card('Curated packs', null,
      h('p', { class: 'muted' },
        `Small sets that fit this server. Each ${status.noun} is fetched from Modrinth and checksum-verified; a restart loads them.`),
      packsHost),
    card('Find more', null, searchBox(searchHost, status, reload), searchHost),
  );

  renderInstalled(installedHost, status, ctx, reload);
  renderPacks(packsHost, status, reload);
  return { element: host };
}

function renderInstalled(host, status, ctx, reload) {
  clear(host);
  const list = status.installed || [];
  if (!list.length) {
    append(host, h('p', { class: 'muted' },
      `Nothing installed yet. Start with a curated pack below, or search Modrinth - files land in ${status.dir}.`));
    return;
  }
  append(host, h('div', { class: 'stack' }, list.map((entry) => h('div', { class: 'row mod-row' },
    h('div', { class: 'mod-name' },
      h('strong', {}, entry.title || entry.file_name),
      entry.managed
        ? h('span', { class: 'muted' }, ` ${entry.version}`)
        : h('span', { class: 'tag' }, 'added by hand')),
    h('span', { class: 'muted mono grow' }, entry.file_name),
    h('span', { class: 'muted' }, bytes(entry.size_bytes)),
    h('button', {
      class: 'btn btn-small btn-danger',
      onclick: async (ev) => {
        const answer = await confirmAction({
          title: `Remove ${entry.title || entry.file_name}?`,
          consequences: ['the file is deleted from the server', 'a restart is needed before the server forgets it'],
          recoverable: 'Recoverable: installing it again fetches the same version from Modrinth.',
          confirmLabel: 'Remove',
        });
        if (!answer.confirmed) return;
        await run(ev.target, async () => {
          await api(`api/mods/${encodeURIComponent(entry.file_name)}`, { method: 'DELETE' });
          await reload();
        }, `${entry.file_name} removed`);
      },
    }, 'Remove'),
  ))));
  append(host, h('p', { class: 'muted' }, 'Changes load on the next server start.'));
}

function renderPacks(host, status, reload) {
  clear(host);
  const packs = status.packs || [];
  if (!packs.length) {
    append(host, h('p', { class: 'muted' }, 'No curated packs fit this flavour yet.'));
    return;
  }
  const installedPacks = new Set((status.installed || []).map((entry) => entry.pack).filter(Boolean));
  append(host, h('div', { class: 'grid cols-2' }, packs.map((pack) => h('div', { class: 'card-inset' },
    h('div', { class: 'row' },
      h('strong', {}, pack.name),
      installedPacks.has(pack.id) ? h('span', { class: 'tag' }, 'installed') : null),
    h('p', { class: 'muted' }, pack.description),
    h('p', { class: 'muted mono' }, pack.projects.join(' · ')),
    h('button', {
      class: 'btn btn-small btn-primary',
      onclick: (ev) => run(ev.target, async () => {
        const { results } = await api(`api/mods/packs/${encodeURIComponent(pack.id)}`, { method: 'POST' });
        const failed = results.filter((r) => r.error);
        if (failed.length) {
          toast(`${results.length - failed.length} installed, ${failed.length} failed: ${failed.map((f) => f.project).join(', ')}`, 'warn', 12000);
        } else {
          toast(`${pack.name} installed. Restart the server to load it.`, 'ok', 9000);
        }
        await reload();
      }),
    }, `Install ${pack.projects.length} ${status.noun}s`),
  ))));
}

function searchBox(resultsHost, status, reload) {
  const input = h('input', { type: 'search', placeholder: `Search Modrinth for server-side ${status.noun}s…` });
  let timer = null;
  const search = async () => {
    clear(resultsHost);
    append(resultsHost, h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' searching…'));
    try {
      const { results } = await api(`api/mods/search?q=${encodeURIComponent(input.value)}`);
      renderResults(resultsHost, results, status, reload);
    } catch (err) {
      clear(resultsHost);
      append(resultsHost, h('p', { class: 'banner error' }, err.message));
    }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(search, 350);
  });
  // Show the most-downloaded content immediately: an empty search box that does
  // nothing reads as broken.
  setTimeout(search, 0);
  return h('div', { class: 'row' }, input);
}

function renderResults(host, results, status, reload) {
  clear(host);
  if (!results.length) {
    append(host, h('p', { class: 'muted' }, 'Nothing on Modrinth matches - for this server version and loader.'));
    return;
  }
  append(host, h('div', { class: 'stack' }, results.map((hit) => h('div', { class: 'row mod-row' },
    h('div', { class: 'mod-name grow' },
      h('strong', {}, hit.title),
      h('div', { class: 'muted' }, hit.description)),
    h('span', { class: 'muted' }, `${num(hit.downloads / 1000, hit.downloads > 100000 ? 0 : 1)}k`),
    hit.installed
      ? h('span', { class: 'tag' }, 'installed')
      : h('button', {
        class: 'btn btn-small btn-primary',
        onclick: (ev) => run(ev.target, async () => {
          await api('api/mods/install', { method: 'POST', body: { project: hit.project } });
          toast(`${hit.title} installed. Restart the server to load it.`, 'ok', 8000);
          await reload();
        }),
      }, 'Install'),
  ))));
}
