// Ports of default lazer input/judgment rules. See THIRD_PARTY_NOTICES.md.
export const SCORING_REVISION = 'lazer-standard-v1';
export const FRAME_MS = 1000 / 60;
export function sliderPosition(object, time) {
  const progress = Math.max(0, Math.min(object.repeats, (time - object.time) / object.span));
  const repeat = Math.min(object.repeats - 1, Math.floor(progress)); let fraction = progress - repeat;
  if (repeat % 2) fraction = 1 - fraction;
  const distance = fraction * object.length;
  let index = 1; while (index < object.distances.length - 1 && object.distances[index] < distance) index++;
  if (object.path.length === 1) return object.path[0];
  fraction = (distance - object.distances[index - 1]) / Math.max(1e-6, object.distances[index] - object.distances[index - 1]);
  return object.path[index - 1].map((value, axis) => value + fraction * (object.path[index][axis] - value));
}
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function updateTracking(object, cursor, keys, previousKeys, radius, time) {
  if (object.head_key && !object.accept_any_key && !(previousKeys & (3 ^ object.head_key))) object.accept_any_key = true;
  const action = object.accept_any_key || !object.head_key ? keys : keys & object.head_key;
  object.tracking = Boolean(action && distance(cursor, sliderPosition(object, time)) <= radius * (object.tracking ? 2.4 : 1));
  return object.tracking;
}
export function spinnerRotation(object, cursor, keys, time) {
  const angle = Math.atan2(cursor[1] - 192, cursor[0] - 256);
  if (object.last_angle !== null && keys && object.time <= time && time < object.end_time) {
    let delta = angle - object.last_angle;
    if(delta>Math.PI)delta-=2*Math.PI;
    if(delta<-Math.PI)delta+=2*Math.PI;
    reportSpinnerDelta(object,delta);
  }
  object.last_angle = angle;
}
export function reportSpinnerDelta(object,delta) {
    object.spin_accumulated += delta;
    let partial = object.spin_accumulated - object.spin_completed_at;
    object.spin_max = Math.max(object.spin_max, Math.abs(partial));
    while (object.spin_max >= 2 * Math.PI) {
      object.spin_count++; object.spin_completed_at += Math.sign(partial) * 2 * Math.PI;
      partial = object.spin_accumulated - object.spin_completed_at; object.spin_max = Math.abs(partial);
    }
    object.rotation = object.spin_count * 2 * Math.PI + object.spin_max;
}
export function spinnerProgress(object, od) {
  const rpm = od < 5 ? 90 + 12 * od : 150 + 15 * (od - 5);
  const required = Math.trunc(rpm / 60 * ((object.end_time - object.time) / 1000) + .0001);
  return required ? object.rotation / (2 * Math.PI * required) : 1;
}
export function spinnerResult(object,od) {
  const progress=spinnerProgress(object,od);
  return progress >= 1 ? 300 : progress > .9 ? 100 : progress > .75 ? 50 : 0;
}
export function createJudge(scene) {
  if (scene.scoring_revision !== SCORING_REVISION) throw new Error('Record a new attempt with the updated lazer rules.');
  const state = {objects: structuredClone(scene.objects), time: 0, points: 0, accuracyMax: 0, hits: 0, combo: 0, best: 0, keys: 0, last: null, events: []};
  function score(object, result, maximum, part, time = state.time, position = [object.x, object.y]) {
    state.points += result; state.accuracyMax += maximum;
    if (result) state.combo++; else if (part !== 'tail') state.combo = 0;
    state.best = Math.max(state.best, state.combo);
    state.last = {id: object.id, result, time, display_time:state.time+FRAME_MS, x: position[0], y: position[1], part, complete: ['circle', 'spinner'].includes(part), accuracy_points: result, accuracy_max: maximum, combo_after: state.combo, max_combo_after: state.best};
    state.events.push({...state.last});
  }
  function complete(object, result) {
    object.result = result; if (result) state.hits++;
    if (object.kind === 'slider') state.events.push({id: object.id, result, time: state.time + FRAME_MS, display_time:state.time+FRAME_MS, x: object.x, y: object.y, part: 'complete', complete: true, accuracy_points: 0, accuracy_max: 0, combo_after: state.combo, max_combo_after: state.best});
  }
  state.step = (cursor, keys) => {
    const time = state.time, next = time + FRAME_MS, previousKeys = state.keys, rising = keys & ~previousKeys; state.keys = keys;
    const active = state.objects.filter(object => object.result === null && object.time <= time + scene.approach_ms);
    const catchup = new Map();
    for (const bit of [1,2]) {
      if (!(rising & bit)) continue;
      for (const object of active) {
        if (object.result !== null || object.kind === 'spinner' || object.head !== null) continue;
        const error = Math.abs(time - object.time);
        if (error > 400 || distance(cursor,[object.x,object.y]) > scene.radius) continue;
        const blocking = active.filter(old => old.time<object.time && old.result===null && old.kind!=='spinner' && old.head===null);
        if(blocking.length && time<blocking.at(-1).time)break;
        for(const old of blocking){
          if(old.kind==='circle'){score(old,0,300,'circle');complete(old,0);}
          else {old.head=0;score(old,0,300,'head');}
        }
        const result = error<=scene.windows[0]?300:error<=scene.windows[1]?100:error<=scene.windows[2]?50:0;
        if(object.kind==='circle'){score(object,result,300,'circle');complete(object,result);}
        else {
          object.head=result;if(result)object.components_hit++;
          object.head_key=result?bit:0;object.accept_any_key=result?!(previousKeys & (3 ^ bit)):true;
          const passed=[];for(let i=object.checkpoint_index;i<object.checkpoints.length;i++)if(object.checkpoints[i]<=time)passed.push(i);
          const inRange=distance(cursor,sliderPosition(object,time))<=scene.radius*2.4;
          const allPassed=inRange && passed.every(i=>distance(cursor,sliderPosition(object,object.checkpoints[i]))<=scene.radius*2.4);
          if(result && passed.length)catchup.set(object.id,[passed.at(-1),allPassed]);
          object.tracking=Boolean(result && (allPassed || distance(cursor,sliderPosition(object,time))<=scene.radius));
          score(object,result,300,'head');
        }
        break;
      }
    }
    for (const object of active) {
      if (object.result !== null) continue;
      if (object.kind === 'circle' && next > object.time + scene.windows[2]) {score(object, 0, 300, 'circle'); complete(object, 0);}
      else if (object.kind === 'slider') {
        if (object.head === null && next > object.time + scene.windows[2]) {object.head = 0; score(object, 0, 300, 'head');}
        if (time >= object.time) updateTracking(object, cursor, keys, previousKeys, scene.radius, time);
        if (object.head !== null) while (object.checkpoint_index < object.checkpoints.length) {
          const index = object.checkpoint_index, targetTime = object.checkpoints[index], tail = index === object.checkpoints.length - 1;
          if (targetTime - (tail ? 36 : 0) > next) break;
          const eventTime = Math.max(time, Math.min(targetTime, next));
          updateTracking(object, cursor, keys, previousKeys, scene.radius, eventTime);
          if (tail && !object.tracking && next < targetTime) break;
          const forced=catchup.get(object.id), hit=forced && index<=forced[0]?forced[1]:object.tracking, part = tail ? 'tail' : object.checkpoint_kinds?.[index] || 'tick', maximum = tail ? 150 : 30;
          if (hit) object.components_hit++;
          score(object, hit ? maximum : 0, maximum, part, eventTime, sliderPosition(object, targetTime));
          if (tail) object.tail_result = hit ? 150 : 0;
          object.checkpoint_index++;
        }
        if (next >= Math.max(object.end_time, object.time + scene.windows[2]) && object.checkpoint_index === object.checkpoints.length) complete(object, object.head);
      } else if (object.kind === 'spinner') {
        spinnerRotation(object, cursor, keys, time);
        if (next >= object.end_time) {const result = spinnerResult(object, scene.od); score(object, result, 300, 'spinner'); complete(object, result);}
      }
    }
    state.time = next;
  };
  state.summary = () => ({accuracy: state.accuracyMax ? state.points / state.accuracyMax : 0, points: state.points, hits: state.hits, combo: state.combo, best: state.best});
  return state;
}

// Reconstruct the displayed instant from recorded judgments, rather than showing
// a later snapshot's scores while the cursor is still playing earlier actions.
export function sceneAt(a, b, time, cursor, keys, tracking, spins) {
  const all = b.judgments || [], clock=e=>e.display_time??e.time, occurred = all.filter(e => clock(e) <= time), completed = new Map(), heads = new Map();
  for (const event of occurred) {if(event.complete)completed.set(event.id,event.result);if(event.part==='head')heads.set(event.id,event.result);}
  const objects = new Map(a.objects.map(object => [object.id,{...object}]));
  for(const object of b.objects)if(!objects.has(object.id) && object.time-b.approach_ms<=time)objects.set(object.id,{...object});
  for(const object of objects.values()){
    if(completed.has(object.id))object.result=completed.get(object.id);
    if(heads.has(object.id))object.head=heads.get(object.id);
    else if(all.some(e=>e.id===object.id && e.part==='head' && clock(e)>time))object.head=null;
    if(tracking)object.tracking=tracking.includes(object.id);
    if(spins){const entry=spins.find(s=>s[0]===object.id);if(entry)object.rotation=entry[1];}
  }
  const added=occurred.filter(e=>clock(e)>a.time),points=a.points+added.reduce((sum,e)=>sum+(e.accuracy_points||0),0);
  const maximum=a.accuracy_max+added.reduce((sum,e)=>sum+(e.accuracy_max||0),0);
  const last=added.at(-1),judged=a.judged+added.filter(e=>e.complete).length,hits=a.hits+added.filter(e=>e.complete && e.result).length;
  return {...b,time,cursor,keys,objects:[...objects.values()].sort((x,y)=>x.time-y.time),points,accuracy_max:maximum,
    accuracy:maximum?points/maximum:0,combo:last?.combo_after??a.combo,max_combo:last?.max_combo_after??a.max_combo,
    judged,hits,hit_rate:judged?hits/judged:0,last_judgment:occurred.filter(e=>e.part!=='complete').at(-1)||a.last_judgment};
}
