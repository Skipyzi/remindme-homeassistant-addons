// Configuration: a structured form for the managed settings and a guarded text
// editor for the raw files.

import { api, h, card, field, run, toast, titleCase, clear, datetime } from '../lib.js';

export async function render(ctx) {
  const data = await api('api/config');
  const groups = new Map();
  for (const knob of data.knobs) {
    if (!groups.has(knob.group)) groups.set(knob.group, []);
    groups.get(knob.group).push(knob);
  }

  const pending = new Map();
  const saveButton = h('button', { class: 'btn btn-primary', disabled: true }, 'Apply changes');
  const restartNote = h('span', { class: 'muted' });

  const updatePending = () => {
    saveButton.disabled = pending.size === 0;
    saveButton.textContent = pending.size ? `Apply ${pending.size} change(s)` : 'Apply changes';
    const needsRestart = [...pending.keys()].some((key) => {
      const knob = data.knobs.find((k) => k.key === key);
      return knob && knob.restart_required;
    });
    restartNote.textContent = needsRestart ? 'A restart is needed for these values to take effect.' : '';
  };

  saveButton.addEventListener('click', (ev) => run(ev.target, async () => {
    const values = Object.fromEntries(pending);
    const result = await api('api/config', { method: 'PUT', body: { values } });
    pending.clear();
    updatePending();
    toast(result.restart_required
      ? 'Saved. Restart the server to apply.'
      : 'Saved.', 'ok');
    await ctx.refreshStatus();
  }));

  const overrides = data.user_overrides || {};
  const groupSections = [...groups.entries()].map(([group, knobs]) => card(titleCase(group), null,
    h('div', { class: 'form-grid' }, knobs.map((knob) => knobField(knob, overrides, (value) => {
      if (String(value) === String(knob.value)) pending.delete(knob.key);
      else pending.set(knob.key, value);
      updatePending();
    })))));

  const fileHost = h('div', {});
  const files = data.files || [];
  const fileSelect = h('select', {},
    files.map((file) => h('option', { value: file.name }, `${file.name}${file.exists ? '' : ' (not created yet)'}`)));
  fileSelect.addEventListener('change', () => loadFile(fileSelect.value, fileHost));

  const element = h('div', { class: 'stack' },
    card('Managed settings',
      h('div', { class: 'card-actions' }, restartNote, saveButton),
      h('p', { class: 'muted' },
        'These values are validated, written atomically and snapshotted. Settings you change here are remembered as manual overrides, so applying a preset later will not silently revert them.')),
    ...groupSections,
    card('Advanced file editor',
      h('div', { class: 'card-actions' }, fileSelect),
      h('p', { class: 'muted' },
        'Only the files the server owns can be edited. Each save creates a snapshot first, is validated for its format and replaces the file atomically.'),
      fileHost),
  );

  if (files.length) await loadFile(files[0].name, fileHost);
  return { element };
}

function knobField(knob, overrides, onChange) {
  const isOverride = Object.prototype.hasOwnProperty.call(overrides, knob.key);
  const labelText = knob.label + (knob.unit ? ` (${knob.unit})` : '') + (isOverride ? ' •' : '');
  let control;

  if (knob.type === 'bool') {
    const input = h('input', { type: 'checkbox' });
    input.checked = Boolean(knob.value);
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'inline', style: 'margin-bottom:.8rem' }, input,
      h('span', {}, labelText, knob.restart_required ? h('span', { class: 'tag' }, 'restart') : null),
      h('span', { class: 'field-hint' }, knob.description));
  }
  if (knob.type === 'enum') {
    control = h('select', {}, knob.enum.map((option) => h('option', {
      value: option, selected: option === knob.value,
    }, option)));
    control.addEventListener('change', () => onChange(control.value));
  } else if (knob.type === 'int' || knob.type === 'float') {
    control = h('input', {
      type: 'number', value: knob.value ?? '', step: knob.type === 'float' ? '0.1' : '1',
      min: knob.min !== undefined ? knob.min : undefined,
      max: knob.max ? knob.max : undefined,
    });
    control.addEventListener('change', () => onChange(Number(control.value)));
  } else {
    control = h('input', { type: 'text', value: knob.value ?? '' });
    control.addEventListener('change', () => onChange(control.value));
  }

  const hint = [knob.description];
  if (knob.source !== 'file') hint.push('(not present in the file yet)');
  if (knob.restart_required) hint.push('restart required');
  return field(labelText, control, hint.join(' — '));
}

async function loadFile(name, host) {
  clear(host);
  host.append(h('p', { class: 'empty' }, h('span', { class: 'spin' }), ' loading…'));
  const data = await api(`api/config/files/${encodeURIComponent(name)}`);
  clear(host);

  const textarea = h('textarea', { spellcheck: 'false' }, data.content || '');
  const info = h('p', { class: 'muted' },
    `${data.file.format} · ${data.file.exists ? `modified ${datetime(data.file.modified_at)}` : 'will be created'}`
    + (data.file.restart_required ? ' · restart required after changes' : ''));

  const snapshots = data.snapshots || [];
  const snapshotSelect = snapshots.length
    ? h('select', {}, h('option', { value: '' }, `${snapshots.length} snapshot(s)…`),
      snapshots.map((snap) => h('option', { value: snap }, snap)))
    : null;

  const save = h('button', {
    class: 'btn btn-primary',
    onclick: (ev) => run(ev.target, async () => {
      const result = await api(`api/config/files/${encodeURIComponent(name)}`, {
        method: 'PUT', body: { content: textarea.value, sha256: data.file.sha256 },
      });
      if (result.unchanged) {
        toast('No changes to write.', 'info');
        return;
      }
      toast(result.restart_required ? 'Saved. Restart to apply.' : 'Saved.', 'ok');
      await loadFile(name, host);
    }),
  }, 'Save file');

  const restore = snapshotSelect
    ? h('button', {
      class: 'btn',
      onclick: (ev) => {
        if (!snapshotSelect.value) {
          toast('Pick a snapshot first.', 'warn');
          return;
        }
        return run(ev.target, async () => {
          await api(`api/config/files/${encodeURIComponent(name)}/restore`, {
            method: 'POST', body: { snapshot: snapshotSelect.value },
          });
          toast('Snapshot restored.', 'ok');
          await loadFile(name, host);
        });
      },
    }, 'Restore snapshot')
    : null;

  host.append(info, textarea,
    h('div', { class: 'card-actions', style: 'margin-top:.5rem' }, save, snapshotSelect, restore));
}
