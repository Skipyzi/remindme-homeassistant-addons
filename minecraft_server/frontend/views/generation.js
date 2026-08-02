// Terrain generation: plan a Chunky run, watch it, and see exactly why the
// guards paused it.

import {
  api, h, card, bar, table, bytes, num, duration, run, toast, confirmAction, clear, titleCase, statePill,
} from '../lib.js';

export async function render(ctx) {
  const host = h('div', { class: 'stack' });
  const statusHost = h('div', {});
  const planHost = h('div', {});

  const reload = async () => {
    const [status, worlds, jobs] = await Promise.all([
      api('api/generation'), api('api/worlds'), api('api/generation/jobs?limit=20'),
    ]);
    clear(host);
    if (status.supported === false) {
      host.append(card('Terrain generation', null,
        h('p', { class: 'banner info' },
          'Terrain pre-generation needs a server plugin, and there is none for this server flavour. '
          + 'The world is generated as players explore it instead.')));
      return;
    }
    host.append(
      statusHost,
      pluginCard(status.plugin, reload),
      planHost,
      card('Guards', null, guardTable(status.guard)),
      card('History', null, jobHistory(jobs.jobs || [])),
    );
    renderStatus(statusHost, status, reload, ctx);
    renderPlanner(planHost, worlds, status, reload);
  };

  await reload();

  const unsubscribe = ctx.subscribe(async (event) => {
    if (['generation_progress', 'generation_paused', 'generation_resumed', 'generation_completed'].includes(event.type)) {
      const status = await api('api/generation');
      renderStatus(statusHost, status, reload, ctx);
    }
  });

  return { element: host, cleanup: unsubscribe };
}

function renderStatus(host, status, reload, ctx) {
  clear(host);
  if (!status.active || !status.job) {
    host.append(card('No job running', null,
      h('p', { class: 'muted' },
        'Pre-generating terrain means players never wait for the Raspberry Pi to build the world while they walk. Plan a run below.')));
    return;
  }
  const job = status.job;
  const params = status.params || {};

  host.append(card('Current job',
    h('div', { class: 'card-actions' },
      job.status === 'paused'
        ? h('button', {
          class: 'btn btn-primary btn-small',
          onclick: (ev) => run(ev.target, async () => {
            await api(`api/generation/jobs/${job.id}/resume`, { method: 'POST' });
            await reload();
          }, 'Resumed'),
        }, 'Resume')
        : h('button', {
          class: 'btn btn-small',
          onclick: (ev) => run(ev.target, async () => {
            await api(`api/generation/jobs/${job.id}/pause`, { method: 'POST' });
            await reload();
          }, 'Paused'),
        }, 'Pause'),
      h('button', {
        class: 'btn btn-small btn-danger',
        onclick: async (ev) => {
          const answer = await confirmAction({
            title: 'Cancel terrain generation?',
            body: 'Chunky stops where it is. Chunks already generated stay on disk, so a later run continues from a smaller remaining area.',
            phrase: 'CANCEL',
            confirmLabel: 'Cancel job',
          });
          if (!answer.confirmed) return;
          await run(ev.target, async () => {
            await api(`api/generation/jobs/${job.id}/cancel?confirm=${encodeURIComponent(answer.phrase)}`, { method: 'POST' });
            await reload();
            await ctx.refreshStatus();
          }, 'Job cancelled');
        },
      }, 'Cancel')),
    h('div', { class: 'row' },
      statePill(job.status),
      h('span', { class: 'tag' }, job.profile),
      h('span', { class: 'muted' }, `${job.world_id} · ${status.dimension || '—'}`)),
    bar(job.progress, job.status === 'paused' ? 'warn' : ''),
    h('div', { class: 'grid metrics', style: 'margin-top:.6rem' },
      metricBox('Progress', `${num(job.progress, 1)} %`, `${job.chunks_done}/${job.chunks_total} chunks`),
      metricBox('Rate', `${num(job.rate, 1)}`, 'chunks per second'),
      metricBox('Elapsed', duration(job.elapsed_ms / 1000), ''),
      metricBox('Remaining', status.remaining_seconds ? duration(status.remaining_seconds) : '—',
        status.estimated_finish ? `finishes around ${new Date(status.estimated_finish).toLocaleTimeString()}` : '')),
    job.pause_reason
      ? h('p', { class: 'banner warn', style: 'margin-top:.6rem' },
        `Paused because of: ${job.pause_reason.split(',').map(titleCase).join(', ')}`)
      : null,
    params.radius_blocks
      ? h('p', { class: 'muted' },
        `radius ${params.radius_blocks} blocks, ${params.shape}, centre ${params.center_at_spawn ? 'world spawn' : `${params.center_x}, ${params.center_z}`}`)
      : null));
}

function metricBox(label, value, sub) {
  return h('div', { class: 'metric' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    sub ? h('div', { class: 'sub' }, sub) : null);
}

function pluginCard(plugin, reload) {
  return card('Chunky plugin',
    h('div', { class: 'card-actions' },
      h('button', {
        class: 'btn btn-small',
        onclick: (ev) => run(ev.target, async () => {
          const data = await api('api/generation/plugin?check=1');
          if (data.error) toast(data.error, 'warn', 10000);
          else if (data.plugin.available_version) toast(`Available: ${data.plugin.available_version}`, 'info', 8000);
          else toast('No newer release found.', 'info');
        }),
      }, 'Check for a release'),
      h('button', {
        class: 'btn btn-small btn-primary',
        onclick: (ev) => run(ev.target, async () => {
          await api('api/generation/plugin/install', { method: 'POST' });
          toast('Chunky installed. Restart Minecraft to load it.', 'ok', 9000);
          await reload();
        }),
      }, plugin.installed ? 'Reinstall' : 'Install Chunky')),
    plugin.installed
      ? h('p', { class: 'muted' },
        `${plugin.file_name} · ${bytes(plugin.size_bytes)} · ${plugin.version || 'version unknown'} · source ${plugin.source || 'unknown'}`
        + (plugin.sha256 ? ` · sha256 ${plugin.sha256.slice(0, 12)}` : ''))
      : h('p', { class: 'banner warn' },
        'Chunky is not installed. Terrain generation needs it; downloads are verified against the checksum published with the release.'));
}

function renderPlanner(host, worlds, status, reload) {
  clear(host);
  const worldSelect = h('select', {},
    (worlds.worlds || []).map((world) => h('option', {
      value: world.id, selected: world.id === worlds.active,
    }, `${world.name || world.id}${world.id === worlds.active ? ' (active)' : ''}`)));

  const shape = h('select', {},
    ['square', 'circle', 'diamond'].map((option) => h('option', { value: option }, option)));
  const radius = h('input', { type: 'number', value: '3000', min: '16', max: '100000' });
  const border = h('input', { type: 'number', value: '2500', min: '0', max: '100000' });
  const margin = h('input', { type: 'number', value: '500', min: '0' });
  const centerX = h('input', { type: 'number', value: '0' });
  const centerZ = h('input', { type: 'number', value: '0' });
  const atSpawn = h('input', { type: 'checkbox' });
  atSpawn.checked = true;
  const applyBorder = h('input', { type: 'checkbox' });
  const profile = h('select', {},
    ['gentle', 'balanced', 'maximum'].map((option) => h('option', { value: option }, titleCase(option))));

  const dims = ['world', 'world_nether', 'world_the_end'].map((dim) => {
    const box = h('input', { type: 'checkbox', value: dim });
    box.checked = dim === 'world';
    return { dim, box };
  });

  const estimateHost = h('div', {});

  const params = () => ({
    world_id: worldSelect.value,
    dimensions: dims.filter((d) => d.box.checked).map((d) => d.dim),
    shape: shape.value,
    radius_blocks: Number(radius.value),
    center_x: Number(centerX.value),
    center_z: Number(centerZ.value),
    center_at_spawn: atSpawn.checked,
    border_radius_blocks: Number(border.value),
    safety_margin_blocks: Number(margin.value),
    profile: profile.value,
    apply_world_border: applyBorder.checked,
  });

  const estimate = async () => {
    clear(estimateHost);
    estimateHost.append(h('p', { class: 'muted' }, h('span', { class: 'spin' }), ' estimating…'));
    try {
      const data = await api('api/generation/estimate', { method: 'POST', body: params() });
      clear(estimateHost);
      // Wrapped in h() rather than appended directly: Element.append turns a
      // conditional null into the literal text "null".
      estimateHost.append(h('div', { class: 'stack' },
        h('div', { class: 'grid metrics' },
          metricBox('Chunks', data.chunks.toLocaleString(),
            `${data.chunks_per_dimension.toLocaleString()} per dimension × ${data.dimensions}`),
          metricBox('Storage estimate', `${bytes(data.low_bytes)} – ${bytes(data.high_bytes)}`,
            data.measured ? 'measured from this world' : 'unmeasured default'),
          metricBox('Needs at least', bytes(data.safe_bytes), 'including the safety margin'),
          metricBox('Free space', bytes(data.free_bytes),
            data.sufficient_space ? 'sufficient' : 'not enough', )),
        data.estimated_minutes
          ? h('p', { class: 'muted' }, `Estimated run time: about ${duration(data.estimated_minutes * 60)}.`)
          : null,
        ...(data.notes || []).map((note) => h('p', { class: 'muted' }, note)),
        data.border_warning ? h('p', { class: 'banner warn' }, data.border_warning) : null,
        data.sufficient_space ? null : h('p', { class: 'banner error' },
          'Generation will not start: there is not enough free space for the estimated area.')));
    } catch (err) {
      clear(estimateHost);
      estimateHost.append(h('p', { class: 'banner error' }, err.message));
    }
  };

  for (const input of [worldSelect, shape, radius, border, margin, centerX, centerZ, profile]) {
    input.addEventListener('change', estimate);
  }
  atSpawn.addEventListener('change', estimate);
  for (const d of dims) d.box.addEventListener('change', estimate);

  host.append(card('Plan a run',
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn btn-small', onclick: () => estimate() }, 'Re-estimate'),
      h('button', {
        class: 'btn btn-primary',
        disabled: status.active,
        onclick: (ev) => run(ev.target, async () => {
          const data = await api('api/generation/jobs', { method: 'POST', body: params() });
          toast(`Job ${data.job.id} started.`, 'ok');
          await reload();
        }),
      }, status.active ? 'A job is already running' : 'Start generation')),
    h('div', { class: 'form-grid' },
      h('label', {}, h('span', { class: 'label-text' }, 'World'), worldSelect),
      h('label', {}, h('span', { class: 'label-text' }, 'Profile'), profile,
        h('span', { class: 'field-hint' }, profileHint())),
      h('label', {}, h('span', { class: 'label-text' }, 'Shape'), shape),
      h('label', {}, h('span', { class: 'label-text' }, 'Generation radius (blocks)'), radius),
      h('label', {}, h('span', { class: 'label-text' }, 'Playable world border radius (blocks)'), border,
        h('span', { class: 'field-hint' }, 'used to warn when players could outrun the generated area')),
      h('label', {}, h('span', { class: 'label-text' }, 'Safety margin (blocks)'), margin),
      h('label', {}, h('span', { class: 'label-text' }, 'Centre X'), centerX),
      h('label', {}, h('span', { class: 'label-text' }, 'Centre Z'), centerZ)),
    h('label', { class: 'inline' }, atSpawn, h('span', {}, 'Centre on the world spawn')),
    h('label', { class: 'inline' }, applyBorder,
      h('span', {}, 'Set the in-game world border to the playable radius when the run finishes')),
    h('fieldset', {}, h('legend', {}, 'Dimensions (generated one after another)'),
      dims.map(({ dim, box }) => h('label', { class: 'inline' }, box, h('span', {}, dim)))),
    estimateHost));

  estimate();
}

function profileHint() {
  return 'Gentle: only while empty, inside the allowed hours. Balanced: higher limits, still yields to players. Maximum: maintenance mode, physical limits only, restarts afterwards.';
}

function guardTable(guard) {
  if (!guard) return h('p', { class: 'empty' }, 'No guard data.');
  const t = guard.thresholds || {};
  const pause = t.pause_when || {};
  const resume = t.resume_when || {};
  const rows = [
    ['Players online', guard.players_online, t.only_when_no_players ? 'pause when above 0' : 'ignored',
      `resume ${t.resume_after_empty_minutes || 0} min after the last player left`],
    ['TPS', num(guard.tps, 2), pause.tps_below ? `pause below ${pause.tps_below}` : 'ignored',
      resume.tps_above ? `resume above ${resume.tps_above}` : ''],
    ['MSPT', num(guard.mspt, 1), pause.mspt_above ? `pause above ${pause.mspt_above} ms` : 'ignored', ''],
    ['CPU temperature', `${num(guard.cpu_temperature_c, 1)} °C`,
      pause.cpu_temperature_above_c ? `pause above ${pause.cpu_temperature_above_c} °C` : 'ignored',
      resume.cpu_temperature_below_c ? `resume below ${resume.cpu_temperature_below_c} °C` : ''],
    ['System CPU', `${num(guard.system_cpu_percent, 0)} %`,
      pause.system_cpu_above_percent ? `pause above ${pause.system_cpu_above_percent} %` : 'ignored',
      resume.system_cpu_below_percent ? `resume below ${resume.system_cpu_below_percent} %` : ''],
    ['Free disk', `${num(guard.disk_free_gb, 1)} GB`,
      pause.disk_free_below_gb ? `cancel below ${pause.disk_free_below_gb} GB` : 'ignored',
      'a full disk corrupts region files, so this cancels instead of pausing'],
    ['Allowed hours', guard.within_allowed_hours ? 'inside window' : 'outside window',
      t.allowed_hours && t.allowed_hours.enabled ? `${t.allowed_hours.start} – ${t.allowed_hours.end}` : 'disabled',
      `minimum dwell ${t.min_dwell_seconds || 0} s between state changes`],
  ];
  return table(['Guard', 'Now', 'Pause rule', 'Recovery'], rows.map((row) => row.map(String)));
}

function jobHistory(jobs) {
  if (!jobs.length) return h('p', { class: 'empty' }, 'No jobs yet.');
  return table(['Job', 'World', 'Profile', 'Status', 'Progress', 'Elapsed'],
    jobs.map((job) => [
      h('span', { class: 'mono' }, job.id),
      job.world_id,
      job.profile,
      h('div', {}, statePill(job.status), job.detail ? h('div', { class: 'muted' }, job.detail) : null),
      `${num(job.progress, 1)} % (${job.chunks_done}/${job.chunks_total})`,
      duration(job.elapsed_ms / 1000),
    ]));
}
