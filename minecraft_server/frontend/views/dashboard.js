// Dashboard: live server and system state, plus the primary controls.

import {
  api, h, card, metric, bar, bytes, duration, ago, num, run, confirmAction, toast, statePill, clear,
} from '../lib.js';

export async function render(ctx) {
  const status = ctx.state.status || await api('api/status');
  const stats = ctx.state.stats || await api('api/stats');

  const metricsHost = h('div', { class: 'grid metrics' });
  const playersHost = h('div', {});
  const generationHost = h('div', {});
  const consoleHost = h('div', { class: 'console', style: 'height:180px' });
  const controlsHost = h('div', { class: 'card-actions' });

  const element = h('div', { class: 'stack' },
    card('Server control', controlsHost,
      h('div', { class: 'row' },
        statePill(status.server.state),
        h('span', { class: 'muted' }, controlSummary(status))),
    ),
    h('div', {}, metricsHost),
    h('div', { class: 'grid cols-2' },
      card('Players', null, playersHost),
      card('Terrain generation', null, generationHost)),
    card('Recent console output',
      h('button', { class: 'btn btn-small', onclick: () => location.hash = '#console' }, 'Open console'),
      consoleHost),
  );

  const paint = () => {
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
    }
  });

  return { element, cleanup: unsubscribe };
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
  clear(host);
  const running = ['running', 'starting', 'stopping', 'backing_up', 'restoring', 'generating', 'maintenance']
    .includes(status.server.state);

  if (!status.eula_accepted) {
    host.append(h('button', {
      class: 'btn btn-primary',
      onclick: async (ev) => {
        const answer = await confirmAction({
          title: 'Accept the Minecraft EULA',
          body: h('div', {},
            h('p', {}, 'Running a Minecraft server requires accepting Mojang’s End User Licence Agreement.'),
            h('p', {}, h('a', { href: 'https://aka.ms/MinecraftEULA', target: '_blank', rel: 'noreferrer' },
              'Read the EULA')),
            h('p', { class: 'muted' }, 'The add-on will never accept this for you.')),
          phrase: 'I-ACCEPT',
          confirmLabel: 'I accept',
          danger: false,
        });
        if (!answer.confirmed) return;
        await run(ev.target, () => api('api/server/eula', {
          method: 'POST', body: { accepted: true, confirm: answer.phrase },
        }), 'EULA accepted');
        await ctx.refreshStatus();
      },
    }, 'Accept EULA'));
    return;
  }

  if (!status.jar.present) {
    host.append(h('button', {
      class: 'btn btn-primary',
      onclick: (ev) => run(ev.target, async () => {
        await api('api/server/install', { method: 'POST' });
        await ctx.refreshStatus();
      }, 'PaperMC installed'),
    }, 'Install PaperMC'));
  }

  host.append(
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
          title: 'Force stop the server',
          body: 'The JVM is killed immediately. Anything not yet saved to disk is lost, which can mean up to one autosave interval of progress.',
          phrase: 'FORCE-STOP',
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

  host.append(
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
      system.disk_total_bytes ? `of ${bytes(system.disk_total_bytes)}` : 'unknown', diskTone),
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
    host.append(h('p', { class: 'empty' }, 'No players online.'));
  } else {
    host.append(h('ul', { class: 'list-plain' }, players.map((name) => h('li', {}, name))));
  }
  if (fresh && telemetry.worlds) {
    const rows = Object.entries(telemetry.worlds).map(([world, data]) => h('li', {},
      h('span', { class: 'tag' }, world), ` ${data.loaded_chunks} chunks · ${data.entities} entities`));
    if (rows.length) host.append(h('h3', { style: 'margin-top:.6rem' }, 'Loaded per dimension'), h('ul', { class: 'list-plain' }, rows));
  }
  if (!fresh) {
    host.append(h('p', { class: 'muted' },
      'Install the management bridge plugin for TPS, MSPT, heap and per-dimension numbers.'));
  }
}

function renderGeneration(host, status) {
  clear(host);
  const gen = status.generation || {};
  if (!gen.active || !gen.job) {
    host.append(h('p', { class: 'empty' }, 'No terrain generation job is running.'),
      h('button', { class: 'btn btn-small', onclick: () => location.hash = '#generation' }, 'Plan a run'));
    return;
  }
  const job = gen.job;
  host.append(
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
  host.append(h('div', { class: `l-${line.stream || 'stdout'}` }, line.text));
  while (host.childElementCount > 200) host.removeChild(host.firstChild);
  if (!bulk) host.scrollTop = host.scrollHeight;
}
