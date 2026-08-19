// Dashboard: live server and system state, plus the primary controls.

import {
  api, h, card, metric, bar, bytes, duration, ago, num, run, confirmAction, toast, statePill, clear, append,
} from '../lib.js';

export async function render(ctx) {
  const status = ctx.state.status || await api('api/status');
  const stats = ctx.state.stats || await api('api/stats');

  const metricsHost = h('div', { class: 'grid metrics' });
  const headerHost = h('div', {});
  const playersHost = h('div', {});
  const generationHost = h('div', {});
  const consoleHost = h('div', { class: 'console', style: 'height:180px' });
  const controlsHost = h('div', { class: 'card-actions' });

  const element = h('div', { class: 'stack' },
    card('Server control', controlsHost, headerHost),
    h('div', {}, metricsHost),
    h('div', { class: 'grid cols-2' },
      card('Players', null, playersHost),
      card('Terrain generation', null, generationHost)),
    card('Recent console output',
      h('button', { class: 'btn btn-small', onclick: () => location.hash = '#console' }, 'Open console'),
      consoleHost),
  );

  const paint = () => {
    renderHeader(headerHost, ctx.state.status);
    renderControls(controlsHost, ctx);
    renderMetrics(metricsHost, ctx.state.status, ctx.state.stats);
    renderPlayers(playersHost, ctx.state.status, ctx.state.stats);
    renderGeneration(generationHost, ctx.state.status);
  };

  ctx.state.stats = stats;
  paint();

  const lines = await api('api/console?limit=40');
  renderConsole(consoleHost, lines.lines || []);

  const unsubscribe = ctx.subscribe((event) => {
    if (event.type === 'stats_update' || event.type === 'status' || event.type === 'server_state'
      || event.type === 'generation_progress' || event.type === 'generation_paused'
      || event.type === 'generation_resumed' || event.type === 'generation_completed') {
      if (event.type === 'generation_progress' && ctx.state.status) {
        // Keep the local copy fresh without another round trip.
        ctx.state.status.generation = ctx.state.status.generation || {};
      }
      paint();
    }
    if (event.type === 'server_log') {
      appendConsoleLine(consoleHost, event.data);
      if (event.data && event.data.source === 'controller' && ctx.state.status) {
        ctx.state.status.server.last_note = event.data.text;
        ctx.state.status.server.last_note_at = new Date().toISOString();
        renderHeader(headerHost, ctx.state.status);
      }
    }
  });

  const ticker = setInterval(() => {
    const state = ctx.state.status && ctx.state.status.server.state;
    if (['starting', 'stopping', 'backing_up', 'restoring', 'switching_world', 'updating', 'generating'].includes(state)) {
      renderHeader(headerHost, ctx.state.status);
    }
  }, 1000);

  return { element, cleanup: () => { clearInterval(ticker); unsubscribe(); } };
}

// renderHeader paints the state pill, the one-line summary and - while anything
// is in flight - what the controller is doing right now and for how long, so a
// long start or backup explains itself instead of looking hung.
function renderHeader(host, status) {
  if (!status) return;
  clear(host);
  const server = status.server;
  append(host, h('div', { class: 'row' },
    statePill(server.state),
    h('span', { class: 'muted' }, controlSummary(status))));

  const transitional = ['starting', 'stopping', 'backing_up', 'restoring', 'switching_world', 'updating', 'generating']
    .includes(server.state);
  if (transitional) {
    let elapsed = '';
    if (server.started_at && server.state === 'starting') {
      const secs = Math.max(0, Math.floor((Date.now() - Date.parse(server.started_at)) / 1000));
      elapsed = ` · ${duration(secs)} elapsed`;
    } else if (server.last_note_at) {
      const secs = Math.max(0, Math.floor((Date.now() - Date.parse(server.last_note_at)) / 1000));
      if (secs > 2) elapsed = ` · ${duration(secs)} ago`;
    }
    append(host, h('p', { class: 'muted activity-line' },
      h('span', { class: 'spin' }), ' ',
      server.last_note || describeState(server.state), elapsed));
  } else if (server.state === 'crashed') {
    append(host, h('p', { class: 'banner error activity-line' },
      `The server exited unexpectedly (code ${server.last_exit_code}). The console has the last lines before the crash.`));
  }
}

function describeState(state) {
  return {
    starting: 'starting - waiting for the server to report ready',
    stopping: 'stopping - asking the server to save and exit',
    backing_up: 'backing up',
    restoring: 'restoring a backup',
    switching_world: 'switching worlds',
    updating: 'updating the server',
    generating: 'generating terrain',
  }[state] || state;
}

// diskCaption names the medium: on a Pi the difference between an SD card and
// an NVMe drive is the difference between stutter and none.
const STORAGE_LABELS = {
  'sd-card': 'SD card',
  nvme: 'NVMe',
  ssd: 'SSD',
  hdd: 'hard disk',
};

function diskCaption(system) {
  if (!system.disk_total_bytes) return 'unknown';
  const medium = STORAGE_LABELS[system.storage_kind];
  return medium ? `of ${bytes(system.disk_total_bytes)} on ${medium}` : `of ${bytes(system.disk_total_bytes)}`;
}

function controlSummary(status) {
  const parts = [];
  if (status.server.pid) parts.push(`pid ${status.server.pid}`);
  if (status.server.uptime_seconds) parts.push(`uptime ${duration(status.server.uptime_seconds)}`);
  if (status.server.crash_count) parts.push(`${status.server.crash_count} crash(es)`);
  if (status.server.last_exit_code) parts.push(`last exit ${status.server.last_exit_code}`);
  if (status.maintenance_mode) parts.push('maintenance mode');
  return parts.join(' · ');
}

function renderControls(host, ctx) {
  const status = ctx.state.status;

  // First run: everything needed to get from nothing to a running server lives
  // in one guided card - flavour, version, the EULA and the install - instead of
  // being scattered between the dashboard and two Settings sections.
  if (!status.jar.present || !status.eula_accepted) {
    // Stats events repaint the dashboard every few seconds; rebuilding the card
    // then would wipe the user's checkbox and selection mid-interaction. Only
    // rebuild when the facts the card depends on actually change.
    const key = `${status.flavour}|${status.jar.present}|${status.eula_accepted}|${status.server.state}`;
    if (host.dataset.setupKey !== key) {
      host.dataset.setupKey = key;
      clear(host);
      renderSetup(host, ctx, status);
    }
    return;
  }
  delete host.dataset.setupKey;
  clear(host);
  const running = ['running', 'starting', 'stopping', 'backing_up', 'restoring', 'generating', 'maintenance']
    .includes(status.server.state);

  append(host, 
    h('button', {
      class: 'btn btn-primary', disabled: running,
      onclick: (ev) => run(ev.target, async () => {
        await api('api/server/start', { method: 'POST' });
        await ctx.refreshStatus();
      }, 'Starting Minecraft'),
    }, 'Start'),
    h('button', {
      class: 'btn', disabled: !running,
      onclick: (ev) => run(ev.target, async () => {
        await api('api/server/stop', { method: 'POST', body: {} });
        await ctx.refreshStatus();
      }, 'Server stopped'),
    }, 'Graceful stop'),
    h('button', {
      class: 'btn', disabled: !running,
      onclick: (ev) => run(ev.target, async () => {
        await api('api/server/restart', { method: 'POST' });
        await ctx.refreshStatus();
      }, 'Server restarted'),
    }, 'Restart'),
    h('button', {
      class: 'btn btn-danger', disabled: !running,
      onclick: async (ev) => {
        const answer = await confirmAction({
          title: 'Force stop the server?',
          body: 'The JVM is killed immediately, skipping the save-and-exit sequence.',
          consequences: [
            'anything not yet saved to disk is lost - up to one autosave interval of progress',
            'players are disconnected without warning',
          ],
          recoverable: 'Use this only when a graceful stop hangs.',
          wirePhrase: 'FORCE-STOP',
          confirmLabel: 'Force stop',
        });
        if (!answer.confirmed) return;
        await run(ev.target, async () => {
          await api('api/server/stop', { method: 'POST', body: { force: true, confirm: answer.phrase } });
          await ctx.refreshStatus();
        }, 'Server killed');
      },
    }, 'Force stop'),
    h('button', {
      class: 'btn',
      onclick: (ev) => run(ev.target, async () => {
        await api('api/server/maintenance', {
          method: 'POST', body: { enabled: !status.maintenance_mode },
        });
        await ctx.refreshStatus();
      }, status.maintenance_mode ? 'Maintenance mode off' : 'Maintenance mode on'),
    }, status.maintenance_mode ? 'Leave maintenance' : 'Maintenance mode'),
    h('button', {
      class: 'btn',
      onclick: (ev) => run(ev.target, () => api('api/backups', {
        method: 'POST', body: { kind: 'manual', label: 'from the dashboard' },
      }), 'Backup finished'),
    }, 'Back up now'),
  );
}

function renderMetrics(host, status, stats) {
  clear(host);
  const system = (stats && stats.system) || {};
  const telemetry = (stats && stats.telemetry) || {};
  const fresh = stats && stats.telemetry_fresh;
  const sizes = (stats && stats.sizes) || {};
  const worldKey = status.active_world ? `world:${status.active_world}` : null;

  const tpsTone = !fresh ? '' : telemetry.tps && telemetry.tps[0] < 18 ? 'bad'
    : telemetry.tps && telemetry.tps[0] < 19.5 ? 'warn' : '';
  const tempTone = system.cpu_temperature_c >= 78 ? 'bad' : system.cpu_temperature_c >= 70 ? 'warn' : '';
  const diskFreeGB = (system.disk_free_bytes || 0) / (1024 ** 3);
  const diskTone = diskFreeGB && diskFreeGB < 15 ? 'bad' : diskFreeGB && diskFreeGB < 30 ? 'warn' : '';

  append(host, 
    metric('Players', fresh ? `${telemetry.online_players}/${telemetry.max_players || '?'}`
      : String((status.server.players || []).length), fresh ? 'from bridge plugin' : 'from console'),
    metric('TPS', fresh ? num(telemetry.tps ? telemetry.tps[0] : 0, 2) : '—',
      fresh ? `MSPT ${num(telemetry.mspt, 1)} ms` : 'bridge plugin not connected', tpsTone),
    metric('JVM heap', fresh && telemetry.heap_max_mb
      ? `${telemetry.heap_used_mb} MB` : '—',
      fresh && telemetry.heap_max_mb ? `of ${telemetry.heap_max_mb} MB max` : 'needs the bridge plugin'),
    metric('CPU', system.cpu_percent !== undefined ? `${num(system.cpu_percent, 0)} %` : '—',
      `load ${num((system.load_avg || [0])[0], 2)} · ${system.cpu_count || '?'} cores`),
    metric('CPU temperature', system.cpu_temperature_c ? `${num(system.cpu_temperature_c, 1)} °C` : '—',
      system.thermal_throttled ? 'throttling' : 'nominal', tempTone),
    metric('System memory', system.mem_total_bytes
      ? `${num(system.mem_used_percent, 0)} %` : '—',
      system.mem_total_bytes ? `${bytes(system.mem_total_bytes - system.mem_available_bytes)} of ${bytes(system.mem_total_bytes)}` : ''),
    metric('Server process', system.server_rss ? bytes(system.server_rss) : '—',
      system.server_cpu_percent ? `${num(system.server_cpu_percent, 0)} % CPU · ${system.server_threads} threads` : 'stopped'),
    metric('Controller', system.controller_rss ? bytes(system.controller_rss) : '—', 'management process'),
    metric('Free disk', system.disk_total_bytes ? bytes(system.disk_free_bytes) : '—',
      diskCaption(system), system.storage_kind === 'sd-card' ? 'warn' : diskTone),
    metric('World size', worldKey && sizes[worldKey] ? bytes(sizes[worldKey].bytes) : '—',
      worldKey && sizes[worldKey] ? `measured ${ago(sizes[worldKey].updated_at)}` : ''),
    metric('Backup repository', sizes.backups ? bytes(sizes.backups.bytes) : '—',
      status.backups.last_backup_at ? `last backup ${ago(status.backups.last_backup_at)}` : 'no backups yet'),
    metric('Loaded chunks', fresh ? String(telemetry.loaded_chunks || 0) : '—',
      fresh ? `${telemetry.entities || 0} entities` : ''),
  );
}

function renderPlayers(host, status, stats) {
  clear(host);
  const telemetry = (stats && stats.telemetry) || {};
  const fresh = stats && stats.telemetry_fresh;
  const players = fresh ? (telemetry.players || []) : (status.server.players || []);
  if (!players.length) {
    append(host, h('p', { class: 'empty' }, 'No players online.'));
  } else {
    append(host, h('ul', { class: 'list-plain' }, players.map((name) => h('li', {}, name))));
  }
  if (fresh && telemetry.worlds) {
    const rows = Object.entries(telemetry.worlds).map(([world, data]) => h('li', {},
      h('span', { class: 'tag' }, world), ` ${data.loaded_chunks} chunks · ${data.entities} entities`));
    if (rows.length) append(host, h('h3', { style: 'margin-top:.6rem' }, 'Loaded per dimension'), h('ul', { class: 'list-plain' }, rows));
  }
  if (!fresh) {
    append(host, h('p', { class: 'muted' },
      'Install the management bridge plugin for TPS, MSPT, heap and per-dimension numbers.'));
  }
}

function renderGeneration(host, status) {
  clear(host);
  const gen = status.generation || {};
  if (!gen.active || !gen.job) {
    append(host, h('p', { class: 'empty' }, 'No terrain generation job is running.'),
      h('button', { class: 'btn btn-small', onclick: () => location.hash = '#generation' }, 'Plan a run'));
    return;
  }
  const job = gen.job;
  append(host, 
    h('div', { class: 'row' },
      statePill(job.status),
      h('span', { class: 'muted' }, `${gen.dimension || job.world_id} · ${job.profile}`)),
    bar(job.progress, job.status === 'paused' ? 'warn' : ''),
    h('p', { class: 'muted', style: 'margin-top:.4rem' },
      `${job.chunks_done}/${job.chunks_total} chunks · ${num(job.rate, 1)} chunks/s`
      + (gen.remaining_seconds ? ` · about ${duration(gen.remaining_seconds)} left` : '')),
    job.pause_reason ? h('p', { class: 'muted' }, `paused: ${job.pause_reason.replace(/,/g, ', ')}`) : null,
    h('div', { class: 'card-actions' },
      job.status === 'paused'
        ? h('button', {
          class: 'btn btn-small',
          onclick: (ev) => run(ev.target, () => api(`api/generation/jobs/${job.id}/resume`, { method: 'POST' }), 'Resumed'),
        }, 'Resume')
        : h('button', {
          class: 'btn btn-small',
          onclick: (ev) => run(ev.target, () => api(`api/generation/jobs/${job.id}/pause`, { method: 'POST' }), 'Paused'),
        }, 'Pause'),
      h('button', { class: 'btn btn-small', onclick: () => location.hash = '#generation' }, 'Details')),
  );
}

function renderConsole(host, lines) {
  clear(host);
  for (const line of lines) appendConsoleLine(host, line, true);
  host.scrollTop = host.scrollHeight;
}

export function appendConsoleLine(host, line, bulk = false) {
  if (!line || !line.text) return;
  append(host, h('div', { class: `l-${line.stream || 'stdout'}` }, line.text));
  while (host.childElementCount > 200) host.removeChild(host.firstChild);
  if (!bulk) host.scrollTop = host.scrollHeight;
}


// ------------------------------------------------------------- first-run setup

function renderSetup(host, ctx, status) {
  const stepsHost = h('div', { class: 'stack setup' });
  append(host, h('div', { class: 'stack' },
    h('p', {}, h('strong', {}, 'Set up your server'),
      h('span', { class: 'muted' }, ' — pick what to run, accept the EULA, install and start. One place, four steps.')),
    stepsHost));

  const state = {
    flavours: null,
    versions: null,
    version: '',
    eulaChecked: Boolean(status.eula_accepted),
    busy: false,
  };

  const paint = () => renderSetupSteps(stepsHost, ctx, status, state, paint);
  paint();

  Promise.all([
    api('api/server/flavours'),
    api('api/server/versions'),
  ]).then(([flavours, versions]) => {
    state.flavours = flavours;
    state.versions = versions;
    state.version = versions.target_version || (versions.versions || [])[0] || '';
    paint();
  }).catch((err) => {
    append(stepsHost, h('p', { class: 'banner error' }, err.message));
  });
}

function renderSetupSteps(host, ctx, status, state, paint) {
  clear(host);
  const step = (n, title, body, done) => h('div', { class: `setup-step${done ? ' done' : ''}` },
    h('div', { class: 'setup-step-title' },
      h('span', { class: 'setup-step-number' }, done ? '✓' : String(n)), ' ', title),
    body);

  // 1. Flavour. Only offered while nothing is installed: afterwards switching
  // is a deliberate act in Settings.
  if (!state.flavours) {
    append(host, step(1, 'Server flavour', h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' loading…'), false));
    return;
  }
  const active = state.flavours.active;
  append(host, step(1, 'Server flavour',
    h('div', { class: 'row' },
      (state.flavours.available || []).map((flavour) => h('button', {
        class: `btn btn-small${flavour.name === active ? ' btn-primary' : ''}`,
        disabled: state.busy || flavour.name === active,
        title: flavour.summary,
        onclick: async () => {
          state.busy = true; paint();
          try {
            // Nothing is installed yet, so the switch moves nothing; the typed
            // ceremony would protect nothing here.
            state.flavours = await api('api/server/flavour', {
              method: 'POST', body: { flavour: flavour.name, confirm: flavour.name },
            });
            state.versions = await api('api/server/versions');
            state.version = state.versions.target_version || (state.versions.versions || [])[0] || '';
            await ctx.refreshStatus();
          } catch (err) {
            toast(err.message, 'error', 8000);
          } finally {
            state.busy = false; paint();
          }
        },
      }, flavour.display_name)),
    ), Boolean(status.jar.present)));

  // 2. Version.
  const versionSelect = h('select', { disabled: state.busy },
    ((state.versions && state.versions.versions) || []).slice(0, 30).map((v) => h('option', {
      value: v, selected: v === state.version,
    }, v)));
  versionSelect.addEventListener('change', () => { state.version = versionSelect.value; });
  append(host, step(2, 'Version',
    h('div', {},
      versionSelect,
      h('p', { class: 'muted' }, 'Newest stable is preselected. Pre-releases can be enabled in Settings.')),
    Boolean(status.jar.present)));

  // 3. EULA. A checkbox, not a typed phrase: the ceremony is reading it.
  const eulaBox = h('input', { type: 'checkbox', disabled: state.busy || status.eula_accepted });
  eulaBox.checked = state.eulaChecked;
  eulaBox.addEventListener('change', () => { state.eulaChecked = eulaBox.checked; paint(); });
  append(host, step(3, 'Minecraft EULA',
    h('label', { class: 'inline' }, eulaBox,
      h('span', {}, 'I have read and accept the ',
        h('a', { href: 'https://aka.ms/MinecraftEULA', target: '_blank', rel: 'noreferrer' }, 'Minecraft EULA'),
        '. The add-on never accepts this for you.')),
    Boolean(status.eula_accepted)));

  // 4. Install and start.
  const ready = state.eulaChecked && (state.version || status.jar.present) && !state.busy;
  append(host, step(4, 'Install and start',
    h('div', {},
      h('button', {
        class: 'btn btn-primary', disabled: !ready,
        onclick: async (ev) => {
          state.busy = true; paint();
          await run(ev.target, async () => {
            if (!status.eula_accepted) {
              await api('api/server/eula', { method: 'POST', body: { accepted: true, confirm: 'I-ACCEPT' } });
            }
            if (!status.jar.present) {
              await api('api/server/update', {
                method: 'POST', body: { version: state.version, build: 0 },
              });
            }
            await api('api/server/start', { method: 'POST' });
            await ctx.refreshStatus();
          }, 'Server installed and starting');
          state.busy = false;
        },
      }, status.jar.present ? 'Start the server' : `Install ${state.version || '…'} and start`),
      h('p', { class: 'muted' },
        'The download is checksum-verified before anything is written. Progress appears above.')),
    false));
}
