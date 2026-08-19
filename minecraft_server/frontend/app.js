// Application shell: shared state, the event stream and view routing.

import {
  api, url, h, clear, toast, statePill, append,
} from './lib.js';
import * as dashboard from './views/dashboard.js';
import * as consoleView from './views/console.js';
import * as config from './views/config.js';
import * as presets from './views/presets.js';
import * as worlds from './views/worlds.js';
import * as backups from './views/backups.js';
import * as generation from './views/generation.js';
import * as settings from './views/settings.js';
import * as activity from './views/activity.js';

const views = {
  dashboard, console: consoleView, config, presets, worlds, backups, generation, settings, log: activity,
};

/** state is the shared snapshot every view reads from. */
export const state = {
  status: null,
  stats: null,
  generation: null,
  current: 'dashboard',
  listeners: new Set(),
};

/** subscribe registers a callback for stream events; returns an unsubscribe. */
export function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function emit(event) {
  for (const fn of [...state.listeners]) {
    try {
      fn(event);
    } catch (err) {
      console.error('listener failed', err);
    }
  }
}

// ------------------------------------------------------------------ routing --

const viewEl = document.getElementById('view');
let activeCleanup = null;

async function show(name) {
  const view = views[name];
  if (!view) return;
  if (activeCleanup) {
    try {
      activeCleanup();
    } catch { /* a failing cleanup must not block navigation */ }
    activeCleanup = null;
  }
  state.current = name;
  for (const tab of document.querySelectorAll('#tabs button')) {
    tab.classList.toggle('active', tab.dataset.view === name);
  }
  clear(viewEl);
  append(viewEl, h('p', { class: 'empty' }, h('span', { class: 'spin' }), ' loading…'));
  try {
    const rendered = await view.render({ state, subscribe, refreshStatus });
    clear(viewEl);
    append(viewEl, rendered.element ?? rendered);
    activeCleanup = rendered.cleanup ?? null;
    if (location.hash.slice(1) !== name) history.replaceState(null, '', `#${name}`);
  } catch (err) {
    clear(viewEl);
    append(viewEl, h('div', { class: 'banner error' }, `Could not load this page: ${err.message}`));
  }
}

document.getElementById('tabs').addEventListener('click', (ev) => {
  const button = ev.target.closest('button[data-view]');
  if (button) show(button.dataset.view);
});

window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1);
  if (views[name] && name !== state.current) show(name);
});

// ------------------------------------------------------------------- header --

function renderHeader() {
  const status = state.status;
  const subtitle = document.getElementById('subtitle');
  const pill = document.getElementById('state-pill');
  if (!status) return;

  const server = status.server || {};
  pill.replaceWith(Object.assign(statePill(server.state), { id: 'state-pill' }));

  const parts = [];
  if (status.active_world) parts.push(`world ${status.active_world_name || status.active_world}`);
  if (server.version) parts.push(`Minecraft ${server.version}`);
  if (server.build) parts.push(`Paper ${server.build}`);
  if (server.uptime_seconds) parts.push(`up ${Math.floor(server.uptime_seconds / 60)} min`);
  subtitle.textContent = parts.join(' · ') || 'ready';
}

function renderBanners() {
  const host = document.getElementById('banner-area');
  clear(host);
  const warnings = (state.status && state.status.warnings) || [];
  for (const warning of warnings) {
    append(host, h('div', { class: 'banner warn' }, h('span', {}, warning)));
  }
}

export async function refreshStatus() {
  state.status = await api('api/status');
  state.generation = state.status.generation;
  renderHeader();
  renderBanners();
  emit({ type: 'status', data: state.status });
  return state.status;
}

// ------------------------------------------------------------------- stream --

function connectStream() {
  const pill = document.getElementById('stream-pill');
  const source = new EventSource(url('api/events'));

  const setPill = (text, cls) => {
    pill.textContent = text;
    pill.className = `pill ${cls}`;
  };

  source.addEventListener('open', () => setPill('live', 'pill-running'));
  source.addEventListener('error', () => setPill('reconnecting', 'pill-warn'));

  const forward = (type) => source.addEventListener(type, (ev) => {
    let data = null;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(type, data.data ?? data);
  });

  [
    'server_state', 'server_log', 'stats_update', 'player_join', 'player_leave',
    'backup_progress', 'restore_progress', 'generation_progress', 'generation_paused',
    'generation_resumed', 'generation_completed', 'worlds_changed', 'backups_changed',
    'config_changed', 'settings_changed', 'warning', 'error',
  ].forEach(forward);

  return source;
}

let statusRefreshTimer = null;

function scheduleStatusRefresh() {
  if (statusRefreshTimer) return;
  statusRefreshTimer = setTimeout(() => {
    statusRefreshTimer = null;
    refreshStatus().catch(() => {});
  }, 400);
}

function handleEvent(type, data) {
  switch (type) {
    case 'stats_update':
      if (data && data.system) {
        state.stats = data;
        if (data.server && state.status) {
          state.status.server = data.server;
          renderHeader();
        }
      }
      break;
    case 'server_state':
      scheduleStatusRefresh();
      break;
    case 'settings_changed':
    case 'config_changed':
    case 'worlds_changed':
      scheduleStatusRefresh();
      break;
    case 'warning':
      toast(data.message || 'warning', 'warn', 10000);
      break;
    case 'error':
      toast(data.message || 'error', 'error', 14000);
      break;
    case 'player_join':
      toast(`${data.player} joined`, 'info', 4000);
      break;
    case 'player_leave':
      toast(`${data.player} left`, 'info', 4000);
      break;
    case 'generation_paused':
      toast(`Terrain generation paused: ${(data.reason || '').replace(/,/g, ', ')}`, 'warn', 9000);
      break;
    case 'generation_resumed':
      toast('Terrain generation resumed', 'ok', 5000);
      break;
    case 'generation_completed':
      toast(`Terrain generation ${data.status}`, data.status === 'completed' ? 'ok' : 'warn', 9000);
      break;
    default:
      break;
  }
  emit({ type, data });
}

// --------------------------------------------------------------------- boot --

async function boot() {
  try {
    await refreshStatus();
  } catch (err) {
    document.getElementById('banner-area').append(
      h('div', { class: 'banner error' }, `The controller is not responding: ${err.message}`));
  }
  connectStream();
  const initial = views[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
  await show(initial);
  // A slow drift refresh keeps values honest even if an event is ever missed.
  setInterval(() => refreshStatus().catch(() => {}), 30000);
}

boot();
