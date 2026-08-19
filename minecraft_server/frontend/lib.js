// Shared helpers: API access, DOM building, formatting, toasts and dialogs.
//
// Every URL is built from the current document path, because under Home Assistant
// Ingress the app is served from /api/hassio_ingress/<token>/ and absolute paths
// would miss the prefix entirely.

const BASE = location.pathname.endsWith('/') ? location.pathname : location.pathname + '/';

export function url(path) {
  return BASE + path.replace(/^\/+/, '');
}

/** api performs a JSON request and throws an Error carrying the server message. */
export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = { 'X-Minecraft-Addon': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url(path), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  if (raw) return res;
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** h builds an element: h('div', {class: 'x'}, 'text', child) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(4)) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * append with h()'s child semantics: null / undefined / false vanish instead of
 * becoming the literal text "null" (which is what the DOM's own append does).
 * Every view should use this instead of Element.append when any child is
 * conditional.
 */
export function append(host, ...children) {
  for (const child of children.flat(4)) {
    if (child === undefined || child === null || child === false) continue;
    host.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return host;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ------------------------------------------------------------- formatting ----

export function bytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = n;
  for (const unit of units) {
    value /= 1024;
    if (value < 1024) return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
  }
  return `${value.toFixed(1)} EiB`;
}

export function duration(seconds) {
  if (!seconds || seconds < 0) return '—';
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${s % 60}s`;
  return `${s}s`;
}

// zeroTime is Go's zero value; it reaches the UI whenever a timestamp was never
// set (a world that has not been played yet, for example).
const EPOCH_FLOOR = Date.UTC(1971, 0, 1);

export function ago(iso) {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  if (then < EPOCH_FLOOR) return 'never';
  const delta = (Date.now() - then) / 1000;
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)} min ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} h ago`;
  return `${Math.floor(delta / 86400)} d ago`;
}

export function datetime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  if (date.getTime() < EPOCH_FLOOR) return 'never';
  return date.toLocaleString();
}

export function num(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return Number(value).toFixed(digits);
}

export function titleCase(s) {
  return String(s || '').replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ----------------------------------------------------------------- toasts ----

export function toast(message, kind = 'info', timeout = 6000) {
  const host = document.getElementById('toasts');
  const el = h('div', { class: `toast ${kind}` }, message);
  host.append(el);
  setTimeout(() => el.remove(), timeout);
}

/** run wraps an async action with button disabling and error reporting. */
export async function run(button, action, successMessage) {
  const previous = button ? button.textContent : null;
  if (button) {
    button.disabled = true;
    button.textContent = '…';
  }
  try {
    const result = await action();
    if (successMessage) toast(successMessage, 'ok');
    return result;
  } catch (err) {
    toast(err.message, 'error', 12000);
    throw err;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previous;
    }
  }
}

// ---------------------------------------------------------------- dialogs ----

/**
 * confirmAction shows a confirmation modal. Two tiers, used consistently:
 *
 * - Recoverable actions (an update with rollback, a restore that takes a safety
 *   backup first) show what will happen and how it can be undone, and need one
 *   click. `wirePhrase` is whatever token the API expects; the user never types
 *   it - the ceremony the API encodes is the dialog itself.
 * - Irreversible actions (permanent deletion) additionally require typing the
 *   name of the thing being destroyed (`typeName`), so the reader has to look
 *   at what they are about to lose.
 */
export function confirmAction({
  title,
  body,
  consequences = [],
  recoverable = '',
  typeName = '',
  wirePhrase = '',
  confirmLabel = 'Confirm',
  danger = true,
}) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('dialog');
    const form = document.getElementById('dialog-form');
    const titleEl = document.getElementById('dialog-title');
    const bodyEl = document.getElementById('dialog-body');
    const confirmBtn = document.getElementById('dialog-confirm');

    titleEl.textContent = title;
    clear(bodyEl);
    if (typeof body === 'string' && body) bodyEl.append(h('p', {}, body));
    else if (body) bodyEl.append(body);
    if (consequences.length) {
      bodyEl.append(h('ul', { class: 'consequences' },
        consequences.map((c) => h('li', {}, c))));
    }
    if (typeName) {
      bodyEl.append(h('p', { class: 'banner error' },
        'This cannot be undone.'));
    } else if (recoverable) {
      bodyEl.append(h('p', { class: 'muted' }, recoverable));
    }

    let input = null;
    if (typeName) {
      input = h('input', { type: 'text', autocomplete: 'off', placeholder: typeName });
      bodyEl.append(
        h('label', {},
          h('span', { class: 'label-text' }, `Type ${typeName} to continue`),
          input),
      );
      confirmBtn.disabled = true;
      input.addEventListener('input', () => {
        confirmBtn.disabled = input.value.trim() !== typeName;
      });
    } else {
      confirmBtn.disabled = false;
    }
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';

    const onClose = () => {
      form.removeEventListener('close', onClose);
      dialog.removeEventListener('close', onClose);
      const confirmed = dialog.returnValue === 'confirm';
      resolve(confirmed
        ? { confirmed: true, phrase: wirePhrase || typeName || '' }
        : { confirmed: false });
    };
    dialog.addEventListener('close', onClose, { once: true });
    dialog.showModal();
    if (input) input.focus();
  });
}

// ----------------------------------------------------------- small widgets ---

export function metric(label, value, sub, tone) {
  return h('div', { class: `metric${tone ? ' ' + tone : ''}` },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    sub ? h('div', { class: 'sub' }, sub) : null);
}

export function card(title, actions, ...children) {
  return h('section', { class: 'card' },
    title || actions
      ? h('header', {},
        title ? h('h2', {}, title) : h('span'),
        actions ? h('div', { class: 'card-actions' }, actions) : null)
      : null,
    ...children);
}

export function bar(percent, tone) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  return h('div', { class: `bar${tone ? ' ' + tone : ''}` }, h('span', { style: `width:${clamped}%` }));
}

export function field(labelText, control, hint) {
  return h('label', {},
    h('span', { class: 'label-text' }, labelText),
    control,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function table(headers, rows) {
  if (!rows.length) return h('p', { class: 'empty' }, 'Nothing here yet.');
  return h('div', { class: 'table-scroll' },
    h('table', {},
      h('thead', {}, h('tr', {}, headers.map((label) => h('th', {}, label)))),
      h('tbody', {}, rows.map((cells) => h('tr', {}, cells.map((cell) => h('td', {}, cell)))))));
}

export function statePill(state) {
  const tone = {
    running: 'pill-running',
    stopped: 'pill-stopped',
    crashed: 'pill-crashed',
    starting: 'pill-busy',
    stopping: 'pill-busy',
    restarting: 'pill-busy',
    backing_up: 'pill-busy',
    restoring: 'pill-busy',
    switching_world: 'pill-busy',
    generating: 'pill-busy',
    updating: 'pill-busy',
    maintenance: 'pill-warn',
  }[state] || 'pill-unknown';
  return h('span', { class: `pill ${tone}` }, String(state || 'unknown').replace(/_/g, ' '));
}
