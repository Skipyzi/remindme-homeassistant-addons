// Presets: overlays with a mandatory diff before anything is written.

import {
  api, h, card, table, run, toast, confirmAction, clear, append,
} from '../lib.js';

export async function render(ctx) {
  const data = await api('api/presets');
  const host = h('div', { class: 'grid cols-2' });
  const diffHost = h('div', {});

  const paint = (presets, active) => {
    clear(host);
    for (const preset of presets) {
      append(host, card(preset.name,
        h('div', { class: 'card-actions' },
          preset.id === active ? h('span', { class: 'pill pill-running' }, 'active') : null,
          preset.built_in ? h('span', { class: 'tag' }, 'built in') : h('span', { class: 'tag' }, 'custom')),
        h('p', { class: 'muted' }, preset.description),
        h('p', { class: 'muted' }, `${Object.keys(preset.knobs || {}).length} settings`
          + (preset.settings && preset.settings.memory_max_mb ? ` · heap ${preset.settings.memory_max_mb} MB` : '')),
        h('div', { class: 'card-actions' },
          h('button', {
            class: 'btn btn-primary btn-small',
            onclick: (ev) => run(ev.target, () => showDiff(preset, diffHost, ctx)),
          }, 'Preview and apply'),
          preset.built_in ? null : h('button', {
            class: 'btn btn-danger btn-small',
            onclick: (ev) => run(ev.target, async () => {
              await api(`api/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
              toast('Preset deleted.', 'ok');
              const fresh = await api('api/presets');
              paint(fresh.presets, fresh.active);
            }),
          }, 'Delete')),
      ));
    }
  };

  paint(data.presets, data.active);

  const element = h('div', { class: 'stack' },
    card('Presets', null,
      h('p', { class: 'muted' },
        'A preset is an overlay: it only touches the values it lists, and never applies anything without showing you the diff first. Values you changed by hand are kept unless you explicitly override them.')),
    diffHost,
    host,
    card('Save the current configuration as a preset', null, savePresetForm(async () => {
      const fresh = await api('api/presets');
      paint(fresh.presets, fresh.active);
    })),
  );

  return { element };
}

async function showDiff(preset, host, ctx) {
  const diff = await api(`api/presets/${encodeURIComponent(preset.id)}/diff`);
  clear(host);

  if (!diff.changes || !diff.changes.length) {
    append(host, card(`${preset.name}: nothing to change`, null,
      h('p', { class: 'muted' }, `Every value in this preset already matches the live configuration (${diff.unchanged} checked).`)));
    return;
  }

  const rows = diff.changes.map((change) => [
    change.label,
    h('span', { class: 'diff-remove mono' }, formatValue(change.current)),
    h('span', { class: 'diff-add mono' }, formatValue(change.new)),
    h('span', {},
      change.file ? h('span', { class: 'tag' }, change.file) : h('span', { class: 'tag' }, 'controller'),
      change.restart_required ? h('span', { class: 'tag' }, 'restart') : null,
      change.user_override ? h('span', { class: 'pill pill-warn' }, 'your change') : null),
  ]);

  const overrideBox = h('input', { type: 'checkbox' });
  append(host, card(`Apply ${preset.name}?`,
    h('div', { class: 'card-actions' },
      h('button', {
        class: 'btn btn-primary',
        onclick: (ev) => run(ev.target, async () => {
          const result = await api(`api/presets/${encodeURIComponent(preset.id)}/apply`, {
            method: 'POST', body: { override_user_changes: overrideBox.checked },
          });
          const skipped = result.skipped ? result.skipped.length : 0;
          toast(`Applied ${result.applied.length} change(s)`
            + (skipped ? `, kept ${skipped} of your own` : '')
            + (result.restart_required ? '. Restart to apply.' : '.'), 'ok', 9000);
          clear(host);
          await ctx.refreshStatus();
        }),
      }, 'Apply preset'),
      h('button', { class: 'btn', onclick: () => clear(host) }, 'Cancel')),
    table(['Setting', 'Current', 'New', 'Where'], rows),
    diff.overrides
      ? h('label', { class: 'inline', style: 'margin-top:.6rem' }, overrideBox,
        h('span', {}, `Also overwrite the ${diff.overrides} value(s) you changed by hand`))
      : null,
    diff.restart_required
      ? h('p', { class: 'muted' }, 'Some of these values only take effect after a server restart.')
      : null,
  ));
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '(unset)';
  return String(value);
}

function savePresetForm(onSaved) {
  const id = h('input', { type: 'text', placeholder: 'my-preset' });
  const name = h('input', { type: 'text', placeholder: 'My preset' });
  const description = h('input', { type: 'text', placeholder: 'What is this for?' });

  return h('div', {},
    h('div', { class: 'form-grid' },
      h('label', {}, h('span', { class: 'label-text' }, 'Identifier'), id),
      h('label', {}, h('span', { class: 'label-text' }, 'Name'), name),
      h('label', {}, h('span', { class: 'label-text' }, 'Description'), description)),
    h('button', {
      class: 'btn',
      onclick: (ev) => run(ev.target, async () => {
        const config = await api('api/config');
        const knobs = {};
        for (const knob of config.knobs) {
          if (knob.source === 'file') knobs[knob.key] = knob.value;
        }
        const settings = await api('api/settings');
        await api('api/presets', {
          method: 'POST',
          body: {
            id: id.value.trim(), name: name.value.trim() || id.value.trim(),
            description: description.value.trim() || 'Saved from the current configuration',
            knobs,
            settings: {
              memory_min_mb: settings.settings.memory_min_mb,
              memory_max_mb: settings.settings.memory_max_mb,
              jvm_flags_profile: settings.settings.jvm_flags_profile,
            },
          },
        });
        toast('Preset saved.', 'ok');
        id.value = '';
        name.value = '';
        description.value = '';
        await onSaved();
      }),
    }, 'Save current settings as a preset'));
}
