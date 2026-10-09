import {createJudge,sliderPosition,sceneAt,spinnerProgress,SCORING_REVISION} from './rules.js';
export {sliderPosition} from './rules.js';
// osu! Rival web app (Arena layout). One file: the app's security policy only serves app.js, style.css and index.html.
// osu! Rival front-end core: API calls, status polling, the practice-field renderer, attempt playback and the
// play-against judge. Layouts import this and only decide where things go. The judge and slider maths match the
// original app.js so practice results are unchanged.
export const fmt = value => Number(value || 0).toLocaleString();
export const percent = (value, digits = 0) => `${(Number(value || 0) * 100).toFixed(digits)}%`;
export const clock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export async function api(path, data) {
  const response = await fetch(new URL(path, location.href), data === undefined ? {cache: 'no-store'}
    : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

export const STATUS = {
  paused: ['Paused', 'idle'], training: ['Training', 'active'], starting: ['Starting', 'busy'], watching: ['Recording an attempt', 'busy'],
  resource_pause: ['Waiting for the Pi', 'warn'], error: ['Needs attention', 'warn'], syncing: ['Loading beatmaps', 'busy'],
};
export const statusOf = state => STATUS[state.status || 'paused'] || [state.status, 'idle'];
export const isTraining = state => Boolean(state.worker_running) && state.status !== 'watching';
export const latestEval = state => {const ev=state.evaluation || state.history?.at(-1);return ev && (ev.scoring_revision===SCORING_REVISION || ev.evaluation_protocol==='lazer-judgments-v3')?ev:null;};
export const baselineOf = state => Object.values(state.baselines || {}).filter(ev=>ev.scoring_revision===SCORING_REVISION).at(-1) || null;
export const evaluationHistory = state => {
  const history = state.history || [], protocol = history.at(-1)?.evaluation_protocol;
  return protocol==='lazer-judgments-v3'?history.filter(point => point.evaluation_protocol === protocol):[];
};

/** Polls /api/status every second while the page is visible and calls `onChange(state)`. */
export function createStore(onChange, onError) {
  const store = {state: {}, busy: false};
  async function refresh() {
    if (store.busy) return; store.busy = true;
    try { store.state = await api('api/status'); onChange(store.state); onError?.(''); }
    catch (error) { onError?.(`Unable to reach the app: ${error.message}`); }
    finally { store.busy = false; }
  }
  store.refresh = refresh;
  store.toggleTraining = async () => { store.state = await api(`api/training/${isTraining(store.state) ? 'pause' : 'start'}`, {}); onChange(store.state); };
  store.sync = async () => { await api('api/maps/sync', {}); await refresh(); };
  store.importMap = async file => {
    if (file.size > 2 * 1024 * 1024) throw new Error('Choose a .osu file smaller than 2 MB.');
    const map = await api('api/maps', {text: await file.text()}); await refresh(); return map;
  };
  store.importCheckpoint = async file => {
    if (file.size > 2.9 * 1024 * 1024) throw new Error('Choose a checkpoint smaller than 2.9 MB.');
    const bytes = new Uint8Array(await file.arrayBuffer()); let text = '';
    for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    await api('api/checkpoints/import', {data: btoa(text)}); await refresh();
  };
  /** Asks for a fresh attempt (optionally on a map) and resolves with it once recorded. */
  store.record = async mapId => {
    const generation=store.state.model_library?.generation;
    const pending = await api('api/watch', mapId ? {map_id: mapId} : {});
    for (;;) {
      await new Promise(r => setTimeout(r, 1000));
      if(generation!==store.state.model_library?.generation)throw new Error('The model changed. Record a new attempt.');
      const attempt = await api('api/attempt');
      if (attempt.id === pending.id) return attempt;
    }
  };
  refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  return store;
}

// ---- the practice field --------------------------------------------------------------------------------------------
export const FIELD_THEME = {bg: '#0d1326', grid: '#1b2743', object: '#aba5fa', slider: '#aba5fa44', ball: '#f3f4fa', approach: '#aba5fa88',
  spinner: '#aba5fa', spin: '#92dec6', rival: '#f187b8', human: '#92dec6', text: '#f3f4fa', miss: '#f187b8', edge: '#ffffff10', trail: true};

/** A canvas that draws the playfield; resizes with its element and draws crisp on high-DPI screens. */
export function createField(canvas, theme = FIELD_THEME) {
  const ctx = canvas.getContext('2d');
  const trail = [];
  function fit() {
    const ratio = devicePixelRatio || 1, box = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(box.width * ratio)), h = Math.max(1, Math.round(box.height * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function viewport(view) {
    const v = view || {world_width: 640, world_height: 512};
    const scale = Math.min(canvas.width / v.world_width, canvas.height / v.world_height);
    return {scale, width: 512 * scale, height: 384 * scale, x: (canvas.width - 512 * scale) / 2, y: (canvas.height - 384 * scale) / 2};
  }
  function clear() { fit(); ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, canvas.width, canvas.height); }
  function draw(scene, time = scene?.time || 0, bot = scene?.cursor || [256, 192], human = null) {
    if (!scene) return;
    clear();
    const vp = viewport(scene.observation_view), s = vp.scale, dpr = devicePixelRatio || 1;
    ctx.save(); ctx.translate(vp.x, vp.y);
    ctx.strokeStyle = theme.edge; ctx.lineWidth = 1 * dpr; ctx.strokeRect(0, 0, vp.width, vp.height);
    ctx.fillStyle = theme.grid;
    for (let x = 32; x < 512; x += 32) for (let y = 32; y < 384; y += 32) { ctx.beginPath(); ctx.arc(x * s, y * s, 1.1 * dpr, 0, Math.PI * 2); ctx.fill(); }
    for (let k = scene.objects.length - 1; k >= 0; k--) {
      const object = scene.objects[k];
      const until = object.time - time;
      if (object.result !== null || until > scene.approach_ms || time > object.end_time + scene.windows[2]) continue;
      const x = object.x * s, y = object.y * s, r = scene.radius * s, fade = Math.min(1, 1.4 - until / scene.approach_ms);
      ctx.globalAlpha = Math.max(.15, fade);
      if (object.kind === 'spinner') {
        ctx.strokeStyle = theme.spinner; ctx.lineWidth = 4 * dpr; ctx.beginPath(); ctx.arc(256 * s, 192 * s, 135 * s, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = theme.spin; ctx.beginPath();
        ctx.arc(256 * s, 192 * s, 120 * s, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0,Math.min(1,spinnerProgress(object,scene.od)))); ctx.stroke();
        ctx.globalAlpha = 1; continue;
      }
      if (object.kind === 'slider') {
        ctx.strokeStyle = theme.slider; ctx.lineWidth = r * 2; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
        object.path.forEach((p, i) => i ? ctx.lineTo(p[0] * s, p[1] * s) : ctx.moveTo(p[0] * s, p[1] * s)); ctx.stroke();
        if (time >= object.time) { const ball = sliderPosition(object, time);
          if(object.tracking){ctx.strokeStyle=theme.human;ctx.lineWidth=2*dpr;ctx.beginPath();ctx.arc(ball[0]*s,ball[1]*s,r*2.4,0,Math.PI*2);ctx.stroke();} ctx.strokeStyle = theme.ball; ctx.lineWidth = 3 * dpr; ctx.beginPath(); ctx.arc(ball[0] * s, ball[1] * s, r, 0, Math.PI * 2); ctx.stroke(); }
      }
      if ((object.kind==='circle' || object.head===null) && until >= -scene.windows[2]) {
        ctx.fillStyle = theme.object + '30'; ctx.strokeStyle = theme.object; ctx.lineWidth = 2.5 * dpr; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = theme.approach; ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(x, y, r * (1 + 2 * Math.max(0, until) / scene.approach_ms), 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    if (bot && theme.trail) {
      trail.push([...bot]); if (trail.length > 10) trail.shift();
      ctx.strokeStyle = theme.rival; ctx.lineCap = 'round';
      for (let i = 1; i < trail.length; i++) { ctx.globalAlpha = i / trail.length * .5; ctx.lineWidth = (2 + i * .5) * dpr; ctx.beginPath(); ctx.moveTo(trail[i - 1][0] * s, trail[i - 1][1] * s); ctx.lineTo(trail[i][0] * s, trail[i][1] * s); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    const cursor = (p, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p[0] * s, p[1] * s, 7.5 * dpr, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = theme.bg; ctx.lineWidth = 2.5 * dpr; ctx.stroke(); };
    if (bot) cursor(bot, theme.rival);
    if (human) cursor(human, theme.human);
    const event = scene.last_judgment;
    if (event && time - event.time < 400) {
      ctx.globalAlpha = 1 - (time - event.time) / 400;
      ctx.font = `700 ${20 * dpr}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillStyle = event.result ? (event.result === 300 ? theme.human : theme.text) : theme.miss;
      const marker=event.part==='tick'||event.part==='repeat'?(event.result?'tick':'slider break'):event.part==='tail'?(event.result?'tail':'tail missed'):event.result||'miss';
      ctx.fillText(marker, event.x * s, event.y * s - (time - event.time) / 25 * dpr); ctx.globalAlpha = 1;
    }
    ctx.restore();
  }
  async function drawPixels(view) {
    const response = await fetch(new URL(`api/frame?t=${Date.now()}`, location.href));
    if (!response.ok) return false;
    const bitmap = await createImageBitmap(await response.blob());
    clear(); ctx.imageSmoothingEnabled = false;
    const vp = viewport(view), k = vp.scale / view.scale;
    if (bitmap.width === view.width && bitmap.height === view.height) ctx.drawImage(bitmap, vp.x - view.offset_x * k, vp.y - view.offset_y * k, view.width * k, view.height * k);
    bitmap.close(); return true;
  }
  return {canvas, draw, drawPixels, clear, viewport, resetTrail: () => { trail.length = 0; }};
}

/** Live view: polls /api/scene while training and draws it (or the learner's pixels). */
/**
 * Live view: polls /api/scene while training and animates between snapshots at the screen's frame rate.
 * Training runs faster than real time and the worker writes a snapshot only every so often, so drawing snapshots as
 * they arrive looks like a slideshow. The view keeps a short buffer, runs a little behind the newest snapshot (about
 * one and a half snapshot gaps, measured as they arrive) and moves the field's clock smoothly between them, so the
 * map plays as a steady fast-forward. If a snapshot carries `trail` ([[time, x, y, keys], …] since the previous
 * one), the cursor follows that real path; otherwise it glides between the known positions.
 * `onScene(scene, {speed})` gets the drawn scene and how many times faster than real time the map is passing.
 */
export function liveView(field, store, {pixels = () => false, onScene} = {}) {
  const POLL = 250;
  let busy = false, on = true, raf = 0, buffer = [], gaps = [], speed = 1;
  const sameRun = (a, b) => a.scoring_revision === b.scoring_revision && a.map?.id === b.map?.id && a.end_time === b.end_time && b.time >= a.time;
  const delay = () => { if (!gaps.length) return 600; const sorted = [...gaps].sort((x, y) => x - y); return Math.max(300, Math.min(3000, sorted[sorted.length >> 1] * 1.5)); };
  async function poll() {
    if (!on || busy || document.hidden || !store.state.worker_running) return; busy = true;
    try {
      const scene = await api('api/scene');
      if (!scene.objects) return;
      if (pixels() && store.state.observation_view) { buffer = []; await field.drawPixels(store.state.observation_view); onScene?.(scene, {speed}); return; }
      const last = buffer.at(-1), now = performance.now();
      if (last && last.scene.time === scene.time && last.scene.map?.id === scene.map?.id) return;   // nothing new yet
      if (last && !sameRun(last.scene, scene)) { buffer = []; field.resetTrail(); }
      else if (last) { gaps.push(now - last.at); if (gaps.length > 8) gaps.shift(); speed = Math.max(.1, (scene.time - last.scene.time) / Math.max(1, now - last.at)); }
      buffer.push({at: now, scene}); if (buffer.length > 10) buffer.shift();
      if (!raf) raf = requestAnimationFrame(frame);
    } catch {} finally { busy = false; }
  }
  function cursorAt(a, b, time, f) {
    const trail = b.scene.trail;
    if (trail?.length) {
      let i = 0; while (i < trail.length - 1 && trail[i + 1][0] <= time) i++;
      const p = trail[i], q = trail[i + 1];
      if (!q || time <= p[0]) return [[p[1], p[2]], p[3],p[4],p[5]];
      const g = (time - p[0]) / Math.max(1e-6, q[0] - p[0]);
      return [[p[1] + (q[1] - p[1]) * g, p[2] + (q[2] - p[2]) * g], p[3],p[4],p[5]];
    }
    return [[a.scene.cursor[0] + (b.scene.cursor[0] - a.scene.cursor[0]) * f, a.scene.cursor[1] + (b.scene.cursor[1] - a.scene.cursor[1]) * f], f < .5 ? a.scene.keys : b.scene.keys];
  }
  function frame(now) {
    raf = 0;
    if (!on || pixels() || !buffer.length) return;
    const show = now - delay();
    let i = buffer.length - 1; while (i > 0 && buffer[i].at > show) i--;
    const a = buffer[i], b = buffer[i + 1];
    let scene = a.scene;
    if (b && show >= a.at) {
      const f = Math.min(1, (show - a.at) / Math.max(1, b.at - a.at)), time = a.scene.time + (b.scene.time - a.scene.time) * f;
      const [cursor, keys,tracking,spins] = cursorAt(a, b, time, f);
      scene=sceneAt(a.scene,b.scene,time,cursor,keys,tracking,spins);
    }
    field.draw(scene); onScene?.(scene, {speed});
    raf = requestAnimationFrame(frame);
  }
  setInterval(poll, POLL);
  return {pause: () => { on = false; cancelAnimationFrame(raf); raf = 0; buffer = []; gaps = []; }, resume: () => { on = true; field.resetTrail(); }};
}

/**
 * Plays a recorded attempt. With `challenge`, the player plays the same section on `field.canvas` (mouse or Z/X) and
 * `onEnd` gets both results. Returns {stop()}.
 */
export function playAttempt(field, attempt, {challenge = false, maps = [], onFrame, onEnd, countdown} = {}) {
  let raf = 0, start = 0, stopped = false, pointer = [256, 192], pressed = 0, mouse = 0, human = null;
  const canvas = field.canvas, listeners = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn]); };
  field.resetTrail();
  if (challenge) {
    human = createJudge(attempt.scene);
    const move = event => {
      const box = canvas.getBoundingClientRect(), vp = field.viewport(attempt.scene.observation_view);
      const x = (event.clientX - box.left) / box.width * canvas.width, y = (event.clientY - box.top) / box.height * canvas.height;
      pointer = [Math.max(0, Math.min(512, (x - vp.x) / vp.scale)), Math.max(0, Math.min(384, (y - vp.y) / vp.scale))];
    };
    on(canvas, 'pointermove', move);
    on(canvas, 'pointerdown', event => { move(event); mouse = 1; canvas.setPointerCapture(event.pointerId); });
    on(canvas, 'pointerup', () => { mouse = 0; }); on(canvas, 'pointercancel', () => { mouse = 0; });
    on(document, 'keydown', event => { const k = event.key.toLowerCase(); if (!['z', 'x'].includes(k) || event.repeat || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return; event.preventDefault(); pressed |= k === 'z' ? 1 : 2; });
    on(document, 'keyup', event => { const k = event.key.toLowerCase(); if (k === 'z') pressed &= ~1; if (k === 'x') pressed &= ~2; });
    on(window, 'blur', () => { pressed = mouse = 0; });
  }
  const scene = attempt.scene, frames = attempt.frames;
  function judgeStep() {human.step(pointer,pressed | mouse);}
  // Full maps have thousands of frames and hundreds of events: walk them once instead of searching every frame.
  const events = [...attempt.events].sort((a, b) => a.time - b.time), rival = {points: 0, accuracyMax: 0, hits: 0, combo: 0, best: 0, last: null};
  const shown = human ? null : scene.objects.map(o => ({...o, result: null})), byId = shown && new Map(shown.map(o => [o.id, o]));
  let fi = 0, ei = 0;
  function frame(now) {
    if (stopped) return;
    const time = now - start;
    while (fi < frames.length - 1 && frames[fi + 1][0] <= time) fi++;
    const f = frames[fi];
    while (ei < events.length && events[ei].time <= time) {
      const e = events[ei++]; rival.points += e.accuracy_points ?? e.result; rival.accuracyMax += e.accuracy_max ?? 300;
      if(e.part !== 'complete')rival.last = e;
      if(!e.part || ['circle','spinner','head'].includes(e.part))if(e.result)rival.hits++;
      if(e.combo_after !== undefined){rival.combo=e.combo_after;rival.best=e.max_combo_after;}
      else if(e.result){rival.combo++;rival.best=Math.max(rival.best,rival.combo);}else rival.combo=0;
      if(byId?.has(e.id)){const o=byId.get(e.id);if(e.part==='head')o.head=e.result;if(e.complete !== false)o.result=e.result;}
    }
    if (human) while (human.time <= time) judgeStep();
    if(shown && f[4])for(const object of shown)object.tracking=f[4].includes(object.id);
    if(shown && f[5])for(const [id,rotation] of f[5])if(byId.has(id))byId.get(id).rotation=rotation;
    const objects = human ? human.objects : shown;
    field.draw({...scene, objects, last_judgment: human ? human.last : rival.last}, time, [f[1], f[2]], human ? pointer : null);
    const total = scene.objects.length;
    onFrame?.({time, end: frames.at(-1)[0], rival: {...rival, accuracy: rival.points / Math.max(1,rival.accuracyMax)}, human: human && {points: human.points, hits: human.hits, combo: human.combo, best: human.best, accuracy: human.points / Math.max(1,human.accuracyMax)}, total});
    if (time >= frames.at(-1)[0]) { stop(false); onEnd?.({rival: attempt.summary, human: human && {accuracy: human.points / Math.max(1,human.accuracyMax), hits: human.hits, best: human.best}}); return; }
    raf = requestAnimationFrame(frame);
  }
  function stop(clean = true) { stopped = true; cancelAnimationFrame(raf); for (const [t, type, fn] of listeners) t.removeEventListener(type, fn); }
  const go = () => { start = performance.now(); raf = requestAnimationFrame(frame); };
  if (challenge && countdown) { field.draw(scene, 0, null, pointer); countdown(go); } else go();
  return {stop};
}

/** Accuracy over updates, the learned line against the starting model. */
export function drawChart(canvas, history, colors = {line: '#f187b8', base: '#afbad3', grid: '#ffffff14', text: '#afbad3', fill: '#f187b822'}, {height = canvas.clientHeight || 200, pad = [36, 14, 14, 26], extra = []} = {}) {
  const ratio = devicePixelRatio || 1, width = canvas.clientWidth;
  canvas.width = width * ratio; canvas.height = height * ratio;
  const c = canvas.getContext('2d'); c.scale(ratio, ratio); c.clearRect(0, 0, width, height);
  const [left, right, top, bottomPad] = [pad[0], width - pad[1], pad[2], height - pad[3]];
  c.font = '11px system-ui, sans-serif'; c.fillStyle = colors.text;
  for (const v of [0, .25, .5, .75, 1]) { const y = bottomPad - v * (bottomPad - top); c.fillText(`${v * 100}%`, 0, y + 4); c.strokeStyle = colors.grid; c.lineWidth = 1; c.beginPath(); c.moveTo(left, y); c.lineTo(right, y); c.stroke(); }
  if (!history?.length) return false;
  const min = history[0].update, max = Math.max(min + 1, history.at(-1).update);
  const x = p => left + (p.update - min) / (max - min) * (right - left), y = v => bottomPad - v * (bottomPad - top);
  c.beginPath(); history.forEach((p, i) => i ? c.lineTo(x(p), y(p.accuracy)) : c.moveTo(x(p), y(p.accuracy)));
  c.lineTo(x(history.at(-1)), bottomPad); c.lineTo(x(history[0]), bottomPad); c.closePath(); c.fillStyle = colors.fill; c.fill();
  for (const [key, color, dashed] of [['baseline', colors.base, true], ...extra.map(([k, c]) => [k, c, false]), ['accuracy', colors.line, false]]) {
    c.strokeStyle = color; c.lineWidth = dashed ? 1.2 : 2.5; c.setLineDash(dashed ? [5, 5] : []); c.lineJoin = 'round'; c.beginPath();
    history.forEach((p, i) => i ? c.lineTo(x(p), y(p[key])) : c.moveTo(x(p), y(p[key]))); c.stroke(); c.setLineDash([]);
  }
  const last = history.at(-1); c.fillStyle = colors.line; c.beginPath(); c.arc(x(last), y(last.accuracy), 4, 0, Math.PI * 2); c.fill();
  c.fillStyle = colors.text; c.textAlign = 'left'; c.fillText(`Update ${fmt(min)}`, left, height - 6); c.textAlign = 'right'; c.fillText(`Update ${fmt(last.update)}`, right, height - 6);
  return true;
}

// ---- the Arena page ----------------------------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const field = createField($('field'));
let mode = 'live', mapId = null, player = null, lastAttempt = null, modelGeneration='';
const parallelFields=new Map();let parallelStamp=null,parallelBusy=false;
async function refreshParallel(){
  if(document.hidden || parallelBusy || !$('parallel-panel').open)return;
  parallelBusy=true;
  try{
    const data=await api('api/runs');
    if(data.updated_at===parallelStamp)return;
    parallelStamp=data.updated_at;
    const runs=data.runs || [],wanted=new Set(runs.map(run=>run.index));
    for(const [index,tile] of parallelFields)if(!wanted.has(index)){tile.row.remove();parallelFields.delete(index);}
    $('parallel-count').textContent=runs.length?`${runs.length} runs`:'';
    if(!runs.length)$('parallel-note').textContent='Start training on the connected PC to see its parallel runs here.';
    else $('parallel-note').textContent='Each run plays a complete real map. Views refresh after a rollout, then stay still while the model learns.';
    for(const run of runs){
      let tile=parallelFields.get(run.index);
      if(!tile){
        const row=document.createElement('article');row.className='parallel-run';row.dataset.run=run.index;
        const heading=document.createElement('h3'),name=document.createElement('p'),canvas=document.createElement('canvas'),progress=document.createElement('p');
        heading.textContent=`Run ${run.index+1}`;name.className='parallel-map';progress.className='note';canvas.setAttribute('aria-label',`Training playfield for run ${run.index+1}`);
        row.append(heading,name,canvas,progress);$('parallel-grid').append(row);
        tile={row,name,progress,field:createField(canvas),map:null};parallelFields.set(run.index,tile);
      }
      const scene=run.scene;
      if(tile.map!==scene.map?.id){tile.field.resetTrail();tile.map=scene.map?.id;}
      tile.name.textContent=`${scene.map?.title || 'Training map'} [${scene.map?.difficulty || ''}]`;
      tile.progress.textContent=`${clock(scene.time)} / ${clock(scene.end_time)} · ${fmt(scene.judged)} of ${fmt(scene.object_count)} objects · ${percent(scene.accuracy)}`;
      tile.field.draw(scene);
    }
  }catch(error){$('parallel-note').textContent=error.message;}
  finally{parallelBusy=false;}
}
setInterval(refreshParallel,1000);$('parallel-panel').addEventListener('toggle',refreshParallel);
const error = message => { $('error').textContent = message; $('error').hidden = !message; };
const store = createStore(render, error);
const live = liveView(field, store, {pixels: () => $('pixels').checked, onScene: (scene, {speed = 1} = {}) => {
  if (mode !== 'live') return;
  $('mode-tag').textContent = speed > 1.5 ? `Live training · ${Math.round(speed)}× speed` : 'Live training';
  $('empty').hidden = true;
  $('map-title').textContent = scene.map?.title || 'Training map'; $('map-sub').textContent = `${scene.map?.difficulty || ''} · full map, ${fmt(scene.judged)} of ${fmt(scene.object_count)} objects played`;
  if (!$('acc')) $('score').innerHTML = '<div class="acc" id="acc">—</div><div class="sub" id="acc-sub"></div>';
  $('acc').textContent = percent(scene.accuracy); $('acc-sub').textContent = `${fmt(scene.hits)} of ${fmt(scene.judged)} hit · best ${scene.max_combo || 0}×`;
  mapSkills(scene);
  $('bar').style.width = `${Math.min(100, scene.time / scene.end_time * 100)}%`; $('time').textContent = `${clock(scene.time)} / ${clock(scene.end_time)}`;
  const keys = Array.isArray(scene.keys) ? (scene.keys[0] ? 1 : 0) | (scene.keys[1] ? 2 : 0) : Number(scene.keys) || 0; $('k1').classList.toggle('on', Boolean(keys & 1)); $('k2').classList.toggle('on', Boolean(keys & 2));
  $('aim').textContent = `aim ${Math.round(scene.cursor[0])}, ${Math.round(scene.cursor[1])}`;
}});

function render(state) {
  const generation=state.model_library?.generation;
  if(modelGeneration && generation && generation!==modelGeneration){
    parallelStamp=null;parallelFields.clear();$('parallel-grid').replaceChildren();
    live.pause();setMode('live');field.clear();lastAttempt=null;
    $('empty').hidden=false;$('map-title').textContent='—';$('map-sub').textContent='';
    $('bar').style.width='0%';$('time').textContent='0:00';$('eye').removeAttribute('src');
  }
  modelGeneration=generation || modelGeneration;
  const active=state.model_library?.models?.find(item=>item.active);
  $('active-model').textContent=active?.name || '';
  $('active-profile').replaceChildren();
  if(active?.profile){const link=document.createElement('a');link.href=active.profile.url;link.textContent=`Server profile: ${active.profile.username}`;link.target='_blank';link.rel='noopener noreferrer';$('active-profile').append(link);}
  if($('models-sheet').classList.contains('open'))drawModels(state.model_library);

  const [label, tone] = statusOf(state);
  $('status').className = `pill ${tone}`; $('status').lastChild.textContent = label;
  $('train').textContent = isTraining(state) ? 'Pause training' : 'Start training';
  $('train').disabled = ['starting', 'watching', 'syncing'].includes(state.status);
  const r = state.resources || {};
  $('resource-title').textContent=state.remote?.attached?'PC trainer':'The Pi';
  $('pi').title=state.remote?.attached?'PC temperature and total trainer memory':'Pi temperature and worker memory';
  $('pi').firstChild.textContent = `${r.temperature_c ?? '—'}°C · ${Math.round(r.worker_memory_mb || 0)} MB`;
  const ev = latestEval(state), base = baselineOf(state);
  $('kpi-acc').textContent = ev ? percent(ev.accuracy) : '—'; $('kpi-base').textContent = base ? percent(base.accuracy) : '—';
  const gain = ev && base ? Math.round((ev.accuracy - base.accuracy) * 100) : null;
  $('kpi-gain').textContent = gain === null ? '' : `${gain > 0 ? '+' : gain < 0 ? '−' : '±'}${Math.abs(gain)} points`; $('kpi-gain').className = gain > 0 ? 'up' : 'down';
  $('split').textContent = ev?.seed_count ? `${fmt(ev.unique_objects)} real objects × ${ev.seed_count} seeds` : state.test_split ? `checked on ${state.test_split}` : '';
  drawChart($('chart'), evaluationHistory(state), undefined, {height: 150, extra: [['hit_rate', '#92dec6']]});
  $('updates').textContent = fmt(state.updates); $('maps-done').textContent = fmt(state.completed_maps ?? state.episodes); $('steps').textContent = fmt(state.steps); $('hits').textContent = ev ? percent(ev.hit_rate) : '—';
  $('slider-hits').textContent = ev?.slider_parts_total ? percent(ev.slider_tracking_hit_rate) : '—';
  $('phase').textContent = state.phase || '';
  const away = state.remote?.attached, par = state.parallel;
  $('where').textContent = away ? `On ${away.name}: ${fmt(away.environments)} environments on ${fmt(away.processes)} of ${fmt(away.cores)} cores` : par ? `${fmt(par.environments)} environments on ${fmt(par.processes)} cores` : '';
  if(state.training?.steps_per_second)$('where').textContent+=` · ${fmt(state.training.steps_per_second)} steps/sec`;
  if(state.trainer_settings?.device === 'gpu')$('where').textContent+=' · GPU learning';
  drawTrainerSettings(state);
  if (away && isTraining(state)) $('status').lastChild.textContent = `Training on ${away.name}`;
  if (!$('remote-sheet').hidden && $('remote-sheet').classList.contains('open')) drawRemote(state);
  const saved = state.checkpoints?.find(c => c.name === 'latest.npz');
  $('download').hidden = !saved; $('saved').textContent = saved ? `Saved ${new Date(saved.modified_at * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}, after every update.` : 'Nothing saved yet.';
  $('map-count').textContent = `${fmt(state.maps?.length)} saved`;
  $('sync-note').textContent = state.map_sync?.at ? `Last sync ${new Date(state.map_sync.at * 1000).toLocaleString([], {dateStyle: 'short', timeStyle: 'short'})}.` : '';
  const o = state.remote?.attached?{...state.options,...state.worker_budget}:state.options || {};
  $('cpu').textContent = `${o.cpu_budget_percent || 25}% per trainer process`; $('cpu-bar').style.setProperty('--v', `${o.cpu_budget_percent || 25}%`);
  $('mem').textContent = `${Math.round(r.worker_memory_mb || 0)} of ${o.memory_limit_mb || 512} MB`; $('mem-bar').style.setProperty('--v', `${Math.min(100, (r.worker_memory_mb || 0) / (o.memory_limit_mb || 512) * 100)}%`);
  $('temp').textContent = r.temperature_c != null ? `${r.temperature_c}°C, pauses at ${o.max_temperature_c || 75}°C` : 'unavailable';
  $('temp-bar').style.setProperty('--v', `${Math.min(100, (r.temperature_c || 0) / (o.max_temperature_c || 75) * 100)}%`);
  $('version').textContent = state.version || '';
  insideModel(state);
  if (state.last_error) error(state.last_error);
  if (mode === 'live' && !state.worker_running) { $('empty').hidden = false; $('score').innerHTML = ''; }
  drawMaps();
}

// map picker
function drawMaps() {
  const maps = store.state.maps || [], q = $('search').value.trim().toLowerCase();
  const list = [{id: null, title: 'The map it is training on', difficulty: store.state.current_map ? `${store.state.current_map.title} [${store.state.current_map.difficulty}]` : 'whatever it is practising now'}, ...maps.filter(m => !q || `${m.title} ${m.artist} ${m.difficulty}`.toLowerCase().includes(q))];
  const sig = list.map(m => m.id).join() + mapId;
  if ($('maps').dataset.sig === sig) return; $('maps').dataset.sig = sig;
  $('maps').innerHTML = list.slice(0, 150).map(m => `<li><button type="button" data-id="${m.id ?? ''}" aria-current="${m.id === mapId}"><b>${esc(m.title)}</b><small>${esc(m.difficulty)}${m.artist ? ` · ${esc(m.artist)}` : ''}</small>${m.objects ? `<em>${fmt(m.objects)} objects<br>AR ${m.ar} · OD ${m.od}</em>` : ''}</button></li>`).join('');
}
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const sheet = open => { $('sheet').classList.toggle('open', open); $('scrim').hidden = !open; if (open) { drawMaps(); $('search').focus(); } };
$('map-open').onclick = () => sheet(true); $('sheet-close').onclick = $('scrim').onclick = () => sheet(false);
$('search').oninput = drawMaps;
$('maps').onclick = event => { const b = event.target.closest('button'); if (!b) return; mapId = b.dataset.id || null; const m = store.state.maps.find(x => x.id === mapId); $('map-name').textContent = m ? `${m.title} [${m.difficulty}]` : 'The map it is training on'; sheet(false); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') sheet(false); });

// modes
function setMode(next) {
  player?.stop(); player = null; mode = next;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === next)));
  for (const id of ['wait', 'count', 'result']) $(id).hidden = true;
  $('keys').hidden = next !== 'challenge'; $('stage').classList.toggle('playing', next === 'challenge');
  $('mode-tag').textContent = {live: 'Live training', watch: 'Recorded attempt', challenge: 'You against the rival'}[next];
  if (next === 'live') { live.resume(); $('score').innerHTML = ''; return; }
  live.pause(); record(next === 'challenge');
}
async function record(challenge) {
  $('empty').hidden = true; $('wait').hidden = false;
  $('wait-note').textContent = store.state.worker_running ? 'It finishes the current training update first.' : 'It plays once from its saved model.';
  try { lastAttempt = await store.record(mapId); if (mode === (challenge ? 'challenge' : 'watch')) start(challenge); }
  catch (e) { error(e.message); setMode('live'); }
}
function start(challenge) {
  const a = lastAttempt; $('wait').hidden = true; $('result').hidden = true;
  $('map-title').textContent = a.title; $('map-sub').textContent = `recorded after ${fmt(a.updates)} updates · ${fmt(a.summary.objects)} objects`;
  $('score').innerHTML = challenge ? '<div class="versus"><div class="r"><small>Rival</small><b id="r-acc">0%</b></div><div class="h"><small>You</small><b id="h-acc">0%</b></div></div>' : '<div class="acc" id="acc">0%</div><div class="sub" id="acc-sub"></div>';
  player = playAttempt(field, a, {challenge, maps: store.state.maps,
    countdown: go => { let n = 3; $('count').hidden = false; $('count-n').textContent = n; const t = setInterval(() => { n--; if (n) $('count-n').textContent = n; else { clearInterval(t); $('count').hidden = true; go(); } }, 700); },
    onFrame: ({time, end, rival, human, total}) => {
      $('bar').style.width = `${time / end * 100}%`; $('time').textContent = `${clock(time)} / ${clock(end)}`;
      if (human) { $('r-acc').textContent = percent(rival.accuracy); $('h-acc').textContent = percent(human.accuracy); }
      else { $('acc').textContent = percent(rival.accuracy); $('acc-sub').textContent = `${rival.hits} / ${total} · ${rival.combo}× combo`; }
    },
    onEnd: ({rival, human}) => {
      if (!human) { $('result-title').textContent = 'Attempt finished'; $('result-grid').innerHTML = `<div class="r"><small>Rival</small><b>${percent(rival.accuracy)}</b><p>${rival.hits} of ${rival.objects} hit</p></div><div><small>Misses</small><b>${rival.results.miss}</b><p>${rival.results['300']} great · ${rival.results['100']} ok</p></div>`; $('again').textContent = 'Watch again'; }
      else { const win = human.accuracy > rival.accuracy, draw = human.accuracy === rival.accuracy; $('result-title').textContent = draw ? 'A draw' : win ? 'You win' : 'Rival wins';
        $('result-grid').innerHTML = `<div class="h${win ? ' won' : ''}"><small>You</small><b>${percent(human.accuracy)}</b><p>${human.hits} hit · best ${human.best}×</p></div><div class="r${!win && !draw ? ' won' : ''}"><small>Rival</small><b>${percent(rival.accuracy)}</b><p>${rival.hits} hit · best ${rival.max_combo}×</p></div>`; $('again').textContent = 'Play again'; }
      $('result').hidden = false;
    }});
}
document.querySelector('.seg').onclick = e => { const b = e.target.closest('button'); if (b) setMode(b.dataset.mode); };
$('again').onclick = () => start(mode === 'challenge'); $('back-live').onclick = () => setMode('live');
$('pixels').onchange = () => { if (mode !== 'live') setMode('live'); };
$('train').onclick = async () => { $('train').disabled = true; try { await store.toggleTraining(); } catch (e) { error(e.message); } finally { $('train').disabled = false; } };

let trainerDraft = false, trainerLoaded = '';
function drawTrainerSettings(state) {
  const remote=state.remote, attached=remote?.attached, settings=remote?.settings || {};
  $('trainer-controls').hidden=!attached;
  if(!attached)return;
  $('trainer-cores').max=Math.min(64, attached.cores);
  $('trainer-device').querySelector('[value="gpu"]').disabled=!attached.gpu?.available;
  $('trainer-gpu').textContent=attached.gpu?.available ? `${attached.gpu.name} · ${attached.gpu.runtime}. The model runs on the GPU; map simulations use the CPU.` : `GPU unavailable: ${attached.gpu?.reason || 'Install a GPU runtime on the trainer.'}`;
  if(!trainerDraft && trainerLoaded!==settings.id) {
    $('trainer-cores').value=settings.processes ?? attached.processes;
    $('trainer-runs').value=settings.environments ?? attached.environments;
    $('trainer-device').value=settings.device || 'cpu'; trainerLoaded=settings.id;
  }
  if(!trainerDraft)$('trainer-result').textContent=state.trainer_settings?.id===settings.id ? 'Settings applied' : isTraining(state) ? 'Applying settings…' : 'Applies when training starts';
}
$('trainer-form').oninput=()=>{trainerDraft=true; $('trainer-result').textContent='';};
$('trainer-form').onsubmit=async event=>{
  event.preventDefault(); $('trainer-apply').disabled=true;
  try {
    const processes=Number($('trainer-cores').value), environments=Number($('trainer-runs').value);
    if(environments<processes)throw new Error('Use at least one parallel run per CPU core.');
    store.state=await api('api/trainer/settings', {processes, environments, device:$('trainer-device').value});
    trainerDraft=false; trainerLoaded=''; drawTrainerSettings(store.state);
  } catch(e) { $('trainer-result').textContent=e.message; }
  finally { $('trainer-apply').disabled=false; }
};
$('sync').onclick = async () => { try { await store.sync(); } catch (e) { error(e.message); } };
$('osu').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { const m = await store.importMap(f); $('sync-note').textContent = `Imported ${m.title}.`; } catch (err) { error(err.message); } e.target.value = ''; };
$('ckpt').onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await store.importCheckpoint(f); $('saved').textContent = 'Model imported.'; } catch (err) { error(err.message); } e.target.value = ''; };
new ResizeObserver(() => drawChart($('chart'), evaluationHistory(store.state), undefined, {height: 150, extra: [['hit_rate', '#92dec6']]})).observe($('chart'));
function insideModel(state) {
  const view = state.observation_view; if (view) $('eye-size').textContent = `${view.width} × ${view.height}`;
  $('m-params').textContent = `${fmt(state.parameters)} parameters`; $('m-source').textContent = state.training_source || 'Real beatmaps';
  const done = state.completed_maps ?? 0, pool = state.training_maps ?? state.maps?.length ?? 0, progress = state.map_progress;
  $('p-done').textContent = fmt(done); $('p-of').textContent = `${done === 1 ? 'map' : 'maps'} played to the end`;
  $('p-bar').style.setProperty('--v', `${progress?.end_time ? Math.min(100, progress.time / progress.end_time * 100) : 0}%`);
  const map = state.current_map;
  $('p-note').textContent = `${map ? `Now on ${map.title} [${map.difficulty}]${progress ? `, ${clock(progress.time)} of ${clock(progress.end_time)}` : ''}. ` : ''}It plays complete maps from ${fmt(pool)} training maps and moves on after the last object. ${state.test_sections ? `${fmt(state.test_sections)} sections of other maps` : 'Some maps'} are kept back to check it fairly.`;
  const names = {'latest.npz': 'Latest', 'best.npz': 'Best so far', 'initial.npz': 'Starting weights'};
  $('ckpts').innerHTML = [...(state.checkpoints || [])].sort((a, b) => b.modified_at - a.modified_at).filter(c => names[c.name] || !c.name.includes('before')).map(c => `<li><span>${esc(names[c.name] || c.name)}</span><span>${(c.bytes / 1024).toFixed(0)} KB · ${new Date(c.modified_at * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</span></li>`).join('') || '<li><span>Nothing saved yet</span></li>';
}
// How it is doing on the map it is playing, from the live scene's running totals.
function mapSkills(scene) {
  const set = (id, text, v) => { $(id).textContent = text; $(`${id}-b`).style.setProperty('--v', `${Math.max(0, Math.min(100, v * 100))}%`); };
  $('sk-map').textContent = scene.map ? `${scene.map.title} [${scene.map.difficulty}]` : '';
  const judged = scene.judged || 0, hits = scene.hits || 0, comp = (scene.components_hit || 0) + (scene.components_missed || 0);
  set('sk-hit', judged ? percent(hits / judged) : '—', judged ? hits / judged : 0);
  set('sk-time', hits ? percent(scene.points / (300 * hits)) : '—', hits ? scene.points / (300 * hits) : 0);
  set('sk-slide', comp ? percent(scene.components_hit / comp) : '—', comp ? scene.components_hit / comp : 0);
  set('sk-combo', `${scene.max_combo || 0}×`, judged ? (scene.max_combo || 0) / Math.max(1, judged) : 0);
  const r = scene.results || {}, keys = [['g', '300', 'great'], ['o', '100', 'ok'], ['m', '50', 'meh'], ['x', 'miss', 'miss']], all = keys.reduce((t, [, k]) => t + (r[k] || 0), 0);
  const sig = keys.map(([, k]) => r[k] || 0).join();
  if ($('judge').dataset.sig === sig) return; $('judge').dataset.sig = sig;
  $('judge').replaceChildren(...keys.filter(([, k]) => r[k]).map(([c, k, word]) => {
    const span = Object.assign(document.createElement('span'), {className: c, title: `${r[k]} ${word}`, textContent: r[k] / all > .07 ? r[k] : ''});
    span.style.flex = String(r[k]); return span;
  }));
}
// The learner's view refreshes every second while the page is visible; its keys light up with the live field.
setInterval(() => { if (!document.hidden && store.state.worker_running) $('eye').src = `api/frame?t=${Date.now()}`; }, 1000);

// ---- training on another computer --------------------------------------------------------------------------------
function drawRemote(state) {
  const remote = state.remote || {}, host = location.hostname || 'HOME-ASSISTANT', hub = `http://${host}:${remote.port || 8100}`;
  const sig = JSON.stringify([remote.enabled, remote.attached, remote.token, isTraining(state)]);
  if ($('remote-body').dataset.sig === sig) return; $('remote-body').dataset.sig = sig;
  if (!remote.enabled) {
    $('remote-body').innerHTML = `<p>A faster PC on your network can do the training and send the model back here.</p>
      <ol><li>In Home Assistant, open this app's <b>Configuration</b> and turn on <b>remote_training</b>.</li><li>Keep port <b>8100</b> mapped under <b>Network</b>.</li><li>Restart the app and come back here for the command.</li></ol>`;
    return;
  }
  const a = remote.attached, token = remote.token || 'TOKEN';
  const quote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
  const get = `curl -fsS -H ${quote('Authorization: Bearer '+token)} ${quote(hub+'/remote/v1/trainer.py')} -o rival-trainer.py`;
  const run = `python3 rival-trainer.py --hub ${quote(hub)} --token ${quote(token)}`;
  $('remote-body').innerHTML = `<div class="remote-status${a ? ' on' : ''}"><i></i><span>${a ? `<b>${esc(a.name)}</b> is connected: ${fmt(a.environments)} environments on ${fmt(a.processes)} of ${fmt(a.cores)} cores. ${isTraining(state) ? 'It is training now.' : 'Press Start training to train there.'}` : 'No computer connected.'}</span></div>
    <p>Run these on the PC (Python 3.10 or newer with numpy and Pillow). It downloads this app's trainer, maps and model, takes over training, and sends progress and the live field back here.</p>
    <div class="cmd"><pre>${esc(get)}</pre><button class="btn" type="button" data-copy="${esc(get)}">Copy</button></div>
    <div class="cmd"><pre>${esc(run)}</pre><button class="btn" type="button" data-copy="${esc(run)}">Copy</button></div>
    <p>Once connected, open <b>Trainer settings</b> on the Training card to change CPU cores, parallel runs and GPU learning. Ctrl+C on the PC stops it, and the latest model is already saved here. Pause, Watch and Play against it keep working from this page.</p>
    <p class="note">The token protects the hub. Anyone with it can train this model, so keep it to yourself.</p>`;
}
const remoteSheet = open => { $('remote-sheet').hidden = false; $('remote-sheet').classList.toggle('open', open); $('scrim').hidden = !open; if (open) { $('remote-body').dataset.sig = ''; drawRemote(store.state); } };
$('remote-sheet').hidden = false;
$('remote-open').onclick = () => remoteSheet(true); $('remote-close').onclick = () => remoteSheet(false);
$('scrim').addEventListener('click', () => remoteSheet(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape') remoteSheet(false); });
$('remote-body').addEventListener('click', async e => { const b = e.target.closest('[data-copy]'); if (!b) return; try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; } setTimeout(() => { b.textContent = 'Copy'; }, 1500); });

let modelAction=false;
let profileModel=null;
function drawModels(library){
  const list=$('model-list');list.replaceChildren();
  for(const item of library?.models || []){
    const row=document.createElement('li'),label=document.createElement('div');
    const name=document.createElement('strong');name.textContent=item.name+(item.active?' · Active':'');
    const detail=document.createElement('p');detail.className='note';detail.textContent=`${fmt(item.steps)} steps · ${fmt(item.updates)} updates`;
    label.append(name,detail);row.append(label);
    const identity=document.createElement('p');identity.className='note';
    if(item.profile){const link=document.createElement('a');link.href=item.profile.url;link.textContent=`${item.profile.username} · server profile`;link.target='_blank';link.rel='noopener noreferrer';identity.append(link);}
    else identity.textContent='No server profile linked';
    label.append(identity);
    for(const [action,title] of [['activate',item.active?'Selected':'Use model'],['discard','Discard']]){
      const button=document.createElement('button');button.className='btn ghost';button.type='button';
      button.textContent=title;button.dataset.action=action;button.dataset.id=item.id;
      button.disabled=modelAction || (action==='activate' && item.active);row.append(button);
    }
    const profile=document.createElement('button');profile.className='btn ghost';profile.type='button';profile.textContent=item.profile?'Change profile':'Link profile';profile.dataset.action='edit-profile';profile.dataset.id=item.id;profile.disabled=modelAction;row.append(profile);
    if(item.profile){const unlink=document.createElement('button');unlink.className='btn ghost';unlink.type='button';unlink.textContent='Unlink';unlink.dataset.action='unlink-profile';unlink.dataset.id=item.id;unlink.disabled=modelAction;row.append(unlink);}
    list.append(row);
  }
}
function modelsSheet(open){
  $('models-sheet').classList.toggle('open',open);$('scrim').hidden=!open;
  if(open){sheet(false);remoteSheet(false);$('scrim').hidden=false;drawModels(store.state.model_library);$('model-name').focus();}
}
async function manageModel(action,data){
  if(modelAction)return;modelAction=true;$('models-note').textContent=action==='profile'?'Saving profile link…':'Saving the current model…';
  $('new-model-form').querySelector('button').disabled=true;drawModels(store.state.model_library);
  try{await api(`api/models/${action}`,data);await store.refresh();$('models-note').textContent=action==='profile'?(data.user_id===null?'Profile unlinked.':'Server profile linked.'):action==='new'?'Fresh model ready. Press Start training to begin.':action==='activate'?'Model selected. Its saved progress is ready.':'Model discarded.';$('model-name').value='';if(action==='profile')$('model-profile-form').hidden=true;}
  catch(e){$('models-note').textContent=e.message;}
  finally{modelAction=false;$('new-model-form').querySelector('button').disabled=false;drawModels(store.state.model_library);}
}
$('models-open').onclick=()=>modelsSheet(true);$('models-close').onclick=()=>modelsSheet(false);
$('scrim').addEventListener('click',()=>modelsSheet(false));
document.addEventListener('keydown',event=>{if(event.key==='Escape')modelsSheet(false);});
$('new-model-form').addEventListener('submit',event=>{event.preventDefault();manageModel('new',{name:$('model-name').value});});
$('model-list').addEventListener('click',event=>{
  const button=event.target.closest('button[data-action]');if(!button)return;
  if(button.dataset.action==='edit-profile')editProfile(button.dataset.id);
  else if(button.dataset.action==='unlink-profile')manageModel('profile',{id:button.dataset.id,user_id:null});
  else manageModel(button.dataset.action,{id:button.dataset.id});
});
async function editProfile(id){
  const item=store.state.model_library.models.find(item=>item.id===id);if(!item)return;
  profileModel=id;$('profile-heading').textContent=`Link ${item.name} to a profile`;$('models-note').textContent='Loading private-server profiles…';
  $('model-profile-form').hidden=true;
  try{
    const data=await api('api/profiles');if(profileModel!==id)return;
    $('profile-user').replaceChildren();
    for(const profile of data.profiles){const option=document.createElement('option');option.value=profile.user_id;option.textContent=`${profile.username} · #${profile.user_id}${profile.is_bot?' · bot':''}`;$('profile-user').append(option);}
    if(!data.profiles.length)throw new Error('No dedicated bot profiles are available yet. Regular player accounts cannot be linked to models.');
    if(item.profile)$('profile-user').value=item.profile.user_id;
    const website=new URL(location.href);website.protocol='http:';website.port='8087';website.pathname='/';website.search='';website.hash='';
    $('profile-website').value=item.profile?.website_url || website.href.replace(/\/$/,'');
    $('models-note').textContent='';$('model-profile-form').hidden=false;$('model-profile-form').scrollIntoView({block:'nearest'});$('profile-user').focus();
  }catch(error){$('models-note').textContent=error.message;}
}
$('profile-cancel').onclick=()=>{profileModel=null;$('model-profile-form').hidden=true;};
$('model-profile-form').addEventListener('submit',event=>{event.preventDefault();manageModel('profile',{id:profileModel,user_id:Number($('profile-user').value),website_url:$('profile-website').value});});
