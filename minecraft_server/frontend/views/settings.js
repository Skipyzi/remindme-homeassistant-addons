// Controller settings: memory, JVM flags, schedules, retention, the generation
// safety policy and server updates.

import {
  api, h, card, field, run, toast, clear, titleCase, bytes, datetime, append,
} from '../lib.js';

export async function render(ctx) {
  const data = await api('api/settings');
  const settings = data.settings;
  const patch = {};

  const bind = (key, input, transform = (v) => v) => {
    input.addEventListener('change', () => {
      patch[key] = transform(input.type === 'checkbox' ? input.checked : input.value);
      saveButton.disabled = false;
    });
    return input;
  };

  const saveButton = h('button', { class: 'btn btn-primary', disabled: true }, 'Save settings');
  saveButton.addEventListener('click', (ev) => run(ev.target, async () => {
    await api('api/settings', { method: 'PUT', body: patch });
    toast('Settings saved.', 'ok');
    for (const key of Object.keys(patch)) delete patch[key];
    saveButton.disabled = true;
    await ctx.refreshStatus();
  }));

  const gen = settings.generation;
  const genPatch = structuredClone(gen);
  const bindGen = (path, input, transform = Number) => {
    input.addEventListener('change', () => {
      const parts = path.split('.');
      let target = genPatch;
      for (const part of parts.slice(0, -1)) target = target[part];
      target[parts[parts.length - 1]] = input.type === 'checkbox' ? input.checked : transform(input.value);
      patch.generation = genPatch;
      saveButton.disabled = false;
    });
    return input;
  };

  const runtime = card('Server runtime', null,
    h('div', { class: 'form-grid' },
      field('Minimum heap (MB)',
        bind('memory_min_mb', h('input', { type: 'number', value: settings.memory_min_mb, min: 512 }), Number),
        'JVM -Xms. Equal to the maximum avoids heap resizing pauses.'),
      field('Maximum heap (MB)',
        bind('memory_max_mb', h('input', { type: 'number', value: settings.memory_max_mb, min: 768 }), Number),
        'On an 8 GB Pi 5 keep this at or below 3584 MB so Home Assistant keeps enough memory.'),
      field('JVM flag profile',
        bind('jvm_flags_profile', h('select', {}, data.jvm_profiles.map((option) => h('option', {
          value: option, selected: option === settings.jvm_flags_profile,
        }, titleCase(option))))),
        'G1 settings validated for Java 21 on aarch64 with a small heap.'),
      field('Custom JVM flags',
        bind('jvm_flags_custom', h('input', {
          type: 'text', value: settings.jvm_flags_custom || '', placeholder: '-XX:+UseG1GC …',
        })),
        'Only used with the custom profile. Heap flags are rejected: they are managed above.'),
      field('Graceful stop timeout (seconds)',
        bind('stop_timeout_seconds', h('input', { type: 'number', value: settings.stop_timeout_seconds, min: 15, max: 900 }), Number),
        'After this, the add-on escalates to SIGTERM and then SIGKILL.')),
    h('label', { class: 'inline' },
      bind('auto_restart_on_crash', checkbox(settings.auto_restart_on_crash)),
      h('span', {}, 'Restart automatically after a crash (never after an intentional stop; gives up after three in a row)')),
    h('label', { class: 'inline' },
      bind('start_on_boot', checkbox(settings.start_on_boot)),
      h('span', {}, 'Start Minecraft when the add-on starts')));

  const schedules = card('Schedules', null,
    h('div', { class: 'form-grid' },
      field('Daily restart (HH:MM, empty to disable)',
        bind('restart_schedule', h('input', { type: 'text', value: settings.restart_schedule || '', placeholder: '04:30' })),
        'Players are warned 10, 5 and 1 minute in advance.'),
      field('Daily backup (HH:MM, empty to disable)',
        bind('backup_schedule', h('input', { type: 'text', value: settings.backup_schedule || '', placeholder: '03:30' })),
        'Runs the same pipeline as a manual backup.'),
      field('Idle shutdown (minutes, 0 to disable)',
        bind('idle_shutdown_minutes', h('input', { type: 'number', value: settings.idle_shutdown_minutes, min: 0 }), Number),
        'Stops the server when nobody has been online for this long.')),
    h('label', { class: 'inline' },
      bind('scheduled_update', checkbox(settings.scheduled_update)),
      h('span', {}, 'Install PaperMC updates automatically during the nightly check (off by default)')));

  const retention = settings.backup_retention;
  const retentionPatch = { ...retention };
  const bindRetention = (key, input) => {
    input.addEventListener('change', () => {
      retentionPatch[key] = Number(input.value);
      patch.backup_retention = retentionPatch;
      saveButton.disabled = false;
    });
    return input;
  };

  const backupSettings = card('Backups', null,
    h('div', { class: 'form-grid' },
      field('Keep last', bindRetention('keep_last', h('input', { type: 'number', value: retention.keep_last, min: 0 }))),
      field('Keep daily', bindRetention('keep_daily', h('input', { type: 'number', value: retention.keep_daily, min: 0 }))),
      field('Keep weekly', bindRetention('keep_weekly', h('input', { type: 'number', value: retention.keep_weekly, min: 0 }))),
      field('Keep monthly', bindRetention('keep_monthly', h('input', { type: 'number', value: retention.keep_monthly, min: 0 })))),
    h('label', { class: 'inline' },
      bind('backup_verify_after_write', checkbox(settings.backup_verify_after_write)),
      h('span', {}, 'Verify the repository structure after every backup')),
    h('label', { class: 'inline' },
      bind('backup_before_config_edit', checkbox(settings.backup_before_config_edit)),
      h('span', {}, 'Take a world backup before large configuration changes')));

  const generationSettings = card('Terrain generation safety', null,
    h('p', { class: 'muted' },
      'These thresholds apply to the Gentle profile as written; Balanced and Maximum widen them. Pause and resume values are deliberately different so a job cannot oscillate.'),
    h('div', { class: 'form-grid' },
      field('Default profile',
        bind('generation_profile', h('select', {}, data.generation_profiles.map((option) => h('option', {
          value: option, selected: option === settings.generation_profile,
        }, titleCase(option)))))),
      field('Pause below TPS', bindGen('pause_when.tps_below', h('input', { type: 'number', step: '0.1', value: gen.pause_when.tps_below }))),
      field('Pause above MSPT', bindGen('pause_when.mspt_above', h('input', { type: 'number', step: '0.1', value: gen.pause_when.mspt_above }))),
      field('Pause above temperature (°C)', bindGen('pause_when.cpu_temperature_above_c', h('input', { type: 'number', value: gen.pause_when.cpu_temperature_above_c }))),
      field('Pause above system CPU (%)', bindGen('pause_when.system_cpu_above_percent', h('input', { type: 'number', value: gen.pause_when.system_cpu_above_percent }))),
      field('Cancel below free disk (GB)', bindGen('pause_when.disk_free_below_gb', h('input', { type: 'number', value: gen.pause_when.disk_free_below_gb }))),
      field('Resume above TPS', bindGen('resume_when.tps_above', h('input', { type: 'number', step: '0.1', value: gen.resume_when.tps_above }))),
      field('Resume below temperature (°C)', bindGen('resume_when.cpu_temperature_below_c', h('input', { type: 'number', value: gen.resume_when.cpu_temperature_below_c }))),
      field('Resume below system CPU (%)', bindGen('resume_when.system_cpu_below_percent', h('input', { type: 'number', value: gen.resume_when.system_cpu_below_percent }))),
      field('Resume delay after the last player left (minutes)', bindGen('resume_after_empty_minutes', h('input', { type: 'number', value: gen.resume_after_empty_minutes }))),
      field('Minimum dwell time (seconds)', bindGen('min_dwell_seconds', h('input', { type: 'number', value: gen.min_dwell_seconds })),
        'A job cannot change state more often than this.'),
      field('Allowed hours start', bindGen('allowed_hours.start', h('input', { type: 'text', value: gen.allowed_hours.start }), String)),
      field('Allowed hours end', bindGen('allowed_hours.end', h('input', { type: 'text', value: gen.allowed_hours.end }), String)),
      field('Safety margin (blocks)', bindGen('safety_margin_blocks', h('input', { type: 'number', value: gen.safety_margin_blocks }))),
      field('Storage safety margin (%)', bindGen('storage_safety_margin_percent', h('input', { type: 'number', value: gen.storage_safety_margin_percent })))),
    h('label', { class: 'inline' }, bindGen('allowed_hours.enabled', checkbox(gen.allowed_hours.enabled)),
      h('span', {}, 'Restrict generation to the allowed hours')),
    h('label', { class: 'inline' }, bindGen('only_when_no_players', checkbox(gen.only_when_no_players)),
      h('span', {}, 'Only generate while no players are online')),
    h('label', { class: 'inline' }, bindGen('dimensions_sequential', checkbox(gen.dimensions_sequential)),
      h('span', {}, 'Generate dimensions one after another')),
    h('label', { class: 'inline' }, bindGen('backup_before_start', checkbox(gen.backup_before_start)),
      h('span', {}, 'Back up before a generation run starts')),
    h('label', { class: 'inline' }, bindGen('backup_after_completion', checkbox(gen.backup_after_completion)),
      h('span', {}, 'Back up after a generation run completes')));

  const flavourHost = h('div', {});
  const flavourCard = card('Server flavour', null, flavourHost);
  loadFlavours(flavourHost, ctx).catch((err) => {
    clear(flavourHost);
    append(flavourHost, h('p', { class: 'banner error' }, err.message));
  });

  const updateHost = h('div', {});
  const updateCard = card('Server version',
    h('button', {
      class: 'btn btn-small',
      onclick: (ev) => run(ev.target, () => loadVersions(updateHost, ctx)),
    }, 'Check for updates'),
    updateHost);

  const optionsCard = card('Add-on options (read only)', null,
    h('p', { class: 'muted' },
      'These come from the add-on configuration page in Home Assistant and need an add-on restart to change.'),
    h('ul', { class: 'list-plain' },
      Object.entries(data.options).map(([key, value]) => h('li', {},
        h('span', { class: 'tag' }, key), ' ', String(value)))));

  const element = h('div', { class: 'stack' },
    card('Settings', h('div', { class: 'card-actions' }, saveButton),
      h('p', { class: 'muted' },
        'Everything here is stored in /data/config/settings.json and survives add-on updates.')),
    runtime, schedules, backupSettings, generationSettings, flavourCard, updateCard, optionsCard);

  loadVersions(updateHost, ctx).catch(() => {});
  return { element };
}

function checkbox(value) {
  const input = h('input', { type: 'checkbox' });
  input.checked = Boolean(value);
  return input;
}

// The flavour picker. Switching is deliberately a separate, confirmed action
// rather than a saved setting: it changes which worlds and which configuration
// the add-on is looking at.
async function loadFlavours(host, ctx) {
  clear(host);
  const data = await api('api/server/flavours');
  const cards = (data.available || []).map((flavour) => {
    const active = flavour.name === data.active;
    const caps = flavour.capabilities || {};
    const missing = [];
    if (!caps.bukkit_plugins) missing.push('no plugins');
    if (!caps.terrain_generation) missing.push('no terrain pre-generation');
    if (!caps.bridge_telemetry) missing.push('no in-server telemetry');

    return h('div', { class: 'card-inset' },
      h('div', { class: 'row' },
        h('strong', {}, flavour.display_name),
        active ? h('span', { class: 'tag' }, 'active') : null,
        data.installed && data.installed[flavour.name]
          ? h('span', { class: 'tag' }, 'installed')
          : null),
      h('p', { class: 'muted' }, flavour.summary),
      missing.length ? h('p', { class: 'muted' }, missing.join(' · ')) : null,
      active ? null : h('button', {
        class: 'btn btn-small',
        disabled: Boolean(data.running),
        onclick: async (ev) => {
          const { confirmAction } = await import('../lib.js');
          const answer = await confirmAction({
            title: `Switch to ${flavour.display_name}?`,
            consequences: [
              'each flavour keeps its own worlds, configuration and installed server',
              'nothing is deleted; switching back restores exactly what is there now',
              'backups stay tied to the flavour they were taken from',
            ],
            recoverable: 'Recoverable: switching back is the same operation.',
            wirePhrase: flavour.name,
            confirmLabel: 'Switch',
            danger: false,
          });
          if (!answer.confirmed) return;
          await run(ev.target, async () => {
            await api('api/server/flavour', {
              method: 'POST',
              body: { flavour: flavour.name, confirm: answer.phrase },
            });
            toast(`Now running ${flavour.display_name}.`, 'ok', 8000);
            await ctx.refreshStatus();
            await loadFlavours(host, ctx);
          });
        },
      }, `Switch to ${flavour.display_name}`));
  });

  append(host, 
    h('div', { class: 'stack' }, cards),
    data.running
      ? h('p', { class: 'banner info' }, 'Stop Minecraft to switch flavours.')
      : null);
}

async function loadVersions(host, ctx) {
  clear(host);
  append(host, h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' asking the PaperMC API…'));
  let data;
  try {
    data = await api('api/server/versions');
  } catch (err) {
    clear(host);
    append(host, h('p', { class: 'banner error' }, err.message));
    return;
  }
  clear(host);

  const installed = data.installed;
  const project = data.project || 'the server project';
  const preReleaseToggle = h('input', { type: 'checkbox' });
  preReleaseToggle.checked = Boolean(data.include_pre_releases);
  preReleaseToggle.addEventListener('change', async () => {
    preReleaseToggle.disabled = true;
    try {
      await api('api/settings', { method: 'PUT', body: { include_pre_releases: preReleaseToggle.checked } });
      await loadVersions(host, ctx);
    } finally {
      preReleaseToggle.disabled = false;
    }
  });

  const versionSelect = h('select', {},
    (data.versions || []).slice(0, 30).map((version) => h('option', {
      value: version, selected: version === data.target_version,
    }, version)));

  append(host, 
    h('p', { class: 'muted' },
      installed.present
        ? `Installed: ${installed.version || 'unknown'} build ${installed.build || '?'} · ${bytes(installed.size_bytes)} · ${datetime(installed.modified_at)}`
        : 'No server JAR is installed yet.'),
    installed.present
      ? h('p', { class: 'muted' },
        `Needs Java ${installed.required_java || 21}; this add-on ships ${installed.java_runtimes || 'unknown'}.`)
      : null,
    installed.java_problem
      ? h('p', { class: 'banner error' }, installed.java_problem)
      : null,
    data.update_available
      ? h('p', { class: 'banner info' },
        `${project} ${data.target_version} build ${data.latest_build} is available.`)
      : h('p', { class: 'muted' }, 'The installed build is current.'),
    data.error ? h('p', { class: 'banner warn' }, data.error) : null,
    h('label', { class: 'inline' }, preReleaseToggle,
      h('span', {}, 'Offer pre-release versions (release candidates and snapshots)')),
    h('div', { class: 'row' },
      versionSelect,
      h('button', {
        class: 'btn btn-primary btn-small',
        onclick: async (ev) => {
          const { confirmAction } = await import('../lib.js');
          const answer = await confirmAction({
            title: `Install ${project} ${versionSelect.value}?`,
            consequences: [
              'the world and configuration are backed up',
              'the server is stopped and the JAR replaced atomically',
              'the server is started again and rolled back if it fails',
            ],
            recoverable: 'Recoverable: the previous JAR is kept and restored on a failed start.',
            wirePhrase: 'UPDATE',
            confirmLabel: 'Install',
          });
          if (!answer.confirmed) return;
          await run(ev.target, async () => {
            const result = await api('api/server/update', {
              method: 'POST',
              body: { version: versionSelect.value, build: 0, confirm: answer.phrase },
            });
            toast(result.rolled_back
              ? 'Update failed and was rolled back.'
              : `Installed build ${result.build}.`, result.rolled_back ? 'warn' : 'ok', 10000);
            await ctx.refreshStatus();
            await loadVersions(host, ctx);
          });
        },
      }, 'Install selected version')),
    h('p', { class: 'muted' },
      'Downloads are verified against the SHA-256 published with the build, and a build that needs a newer Java than this add-on ships is refused before anything is replaced. Automatic updates stay off unless you enable them above.'));
}
