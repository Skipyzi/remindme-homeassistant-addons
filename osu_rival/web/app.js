'use strict';
const $ = id => document.getElementById(id);
const field = $('field'), ctx = field.getContext('2d'), chart = $('chart');
let state = {}, pendingAttempt = null, attempt = null, scene = null, mode = 'live';
let playbackStart = 0, animation = 0, countdownTimer = 0, human = null, pointer = [256, 192], pressed = 0;
let mouseHeld=0;
let statusBusy = false, sceneBusy = false, pixels = null, chartSignature = '';
const fmt = value => Number(value || 0).toLocaleString();
const percent = value => `${Math.round(Number(value || 0) * 100)}%`;
async function api(path, data) {
  const response = await fetch(new URL(path, location.href), data === undefined ? {cache:'no-store'} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
function error(message) {$('error').textContent=message; $('error').hidden=!message;}
function stopPlayback() {cancelAnimationFrame(animation); clearInterval(countdownTimer); animation=0; human=null; pressed=0; $('countdown').hidden=true; $('human-legend').hidden=true; $('field-result').hidden=true;}
function displayStatus() {
  const names = {paused:'Ready to learn',training:'Training',starting:'Starting',watching:'Recording an attempt',resource_pause:'Waiting for the Pi',error:'Needs attention',syncing:'Loading real beatmaps'};
  const status=state.status || 'paused';
  $('status').replaceChildren(Object.assign(document.createElement('i'),{}),document.createTextNode(names[status] || status));
  $('status').className=`status ${['training','watching'].includes(status)?'active':status==='error'||status==='resource_pause'?'warning':''}`;
  const training = state.worker_running && status!=='watching';
  $('train').textContent=training?'Pause training':'Start training';
  $('train').disabled=status==='starting'||status==='watching'||status==='syncing';
  const stage=state.stage || 0;
  $('stage-number').textContent=`${state.maps?.length || 0} real maps`;
  $('stage-name').textContent=state.current_map?.title || 'Your server’s beatmaps';
  $('stage-description').textContent=state.current_map?.difficulty || 'Start training to copy cached maps automatically.';
  $('stage-track').hidden=true;
  $('phase').textContent=state.phase || 'Random weights. No player replays.';
  $('steps').textContent=fmt(state.steps); $('episodes').textContent=fmt(state.episodes);
  $('parameters').textContent=`${fmt(state.parameters)} parameters`; $('version').textContent=state.version || '0.2.2';
  const evaluation=state.evaluation || state.history?.at(-1);
  $('accuracy').textContent=evaluation?percent(evaluation.accuracy):'Awaiting first check';
  $('hit-rate').textContent=evaluation?percent(evaluation.hit_rate):'—';
  const baseline=Object.values(state.baselines || {}).at(-1);
  $('baseline').textContent=baseline?percent(baseline.accuracy):'—';
  const latest=state.checkpoints?.find(item=>item.name==='latest.npz');
  $('download').hidden=!latest;
  $('saved-note').textContent=latest?`Last saved ${new Date(latest.modified_at*1000).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}. ${fmt(state.updates)} completed updates.`:'No checkpoint saved yet.';
  $('cpu-budget').textContent=`One worker, ${state.options?.cpu_budget_percent || 25}% of one CPU core`;
  $('memory').textContent=`Memory budget: ${state.options?.memory_limit_mb || 512} MB${state.resources?.worker_memory_mb?` (${Math.round(state.resources.worker_memory_mb)} MB used)`:''}`;
  $('temperature').textContent=state.resources?.temperature_c!=null?`Temperature: ${state.resources.temperature_c}°C`:'Temperature: unavailable';
  const current=$('pattern').value;
  const options=[{value:'current',label:'Current training section'}, ...(state.maps || []).map(item=>({value:`map:${item.id}`,label:`${item.title} [${item.difficulty}]`}))];
  if (JSON.stringify(options)!==$('pattern').dataset.options) {
    $('pattern').replaceChildren(...options.map(item=>Object.assign(document.createElement('option'),{value:item.value,textContent:item.label})));
    if(options.some(item=>item.value===current)) $('pattern').value=current;
    $('pattern').dataset.options=JSON.stringify(options);
  }
  $('map-note').textContent=`${state.maps?.length || 0} saved real maps. ${state.map_sync?.imported?`${state.map_sync.imported} copied from the server cache. `:''}Circles, sliders and spinners. No player replays.`;
  $('chart-note').textContent=state.test_split?`Evaluation uses ${state.test_split}. Results use the local training judge.`:'Evaluation will use withheld maps or time sections.';
  $('vision-note').textContent=state.observation_view?`The learner sees ${state.observation_view.width} × ${state.observation_view.height} pixels: the full playfield plus a margin on every side.`:'';
  if (state.last_error) error(state.last_error);
  drawChart();
}
function drawChart() {
  const history=state.history || [], signature=JSON.stringify(history)+chart.clientWidth;
  if(signature===chartSignature)return; chartSignature=signature;
  const ratio=devicePixelRatio || 1, width=chart.clientWidth, height=180;
  chart.width=width*ratio; chart.height=height*ratio;
  const c=chart.getContext('2d'); c.scale(ratio,ratio); c.clearRect(0,0,width,height);
  const left=35, right=width-12, top=10, bottom=155;
  c.font='11px Verdana';c.fillStyle='#afbad3';c.lineWidth=1;
  for(const value of [0,.5,1]) {const y=bottom-value*(bottom-top); c.fillText(`${value*100}%`,0,y+4);c.strokeStyle='#344361';c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();}
  $('chart-empty').hidden=history.length>0;
  if(!history.length)return;
  const min=history[0].update, max=Math.max(min+1,history.at(-1).update);
  const x=point=>left+(point.update-min)/(max-min)*(right-left), y=value=>bottom-value*(bottom-top);
  for(const [key,color,dashed] of [['baseline','#afbad3',true],['accuracy','#f187b8',false]]) {
    c.strokeStyle=color;c.lineWidth=dashed?1:2;c.setLineDash(dashed?[5,5]:[]);c.beginPath();
    history.forEach((point,index)=>{if(index===0||point.stage!==history[index-1].stage)c.moveTo(x(point),y(point[key]));else c.lineTo(x(point),y(point[key]));});c.stroke();c.setLineDash([]);
    if(!dashed)for(const point of history){c.fillStyle=color;c.beginPath();c.arc(x(point),y(point[key]),2.8,0,Math.PI*2);c.fill();}
  }
  c.fillStyle='#afbad3';c.fillText(`Update ${min}`,left,178);c.textAlign='right';c.fillText(`Update ${history.at(-1).update}`,right,178);
}
function fieldViewport() {
  const view=state.observation_view || {world_width:640,world_height:512};
  const scale=Math.min(field.width/view.world_width,field.height/view.world_height);
  const width=512*scale,height=384*scale;
  return {scale,width,height,x:(field.width-width)/2,y:(field.height-height)/2};
}
function clearField() {
  ctx.fillStyle='#10182e';ctx.fillRect(0,0,field.width,field.height);
}
function drawScene(value, time=value?.time || 0, bot=value?.cursor || [256,192], humanPointer=null) {
  if(!value)return;
  const viewport=fieldViewport(),scale=viewport.scale;
  clearField();ctx.save();ctx.translate(viewport.x,viewport.y);
  ctx.strokeStyle='#1b2743';ctx.lineWidth=1;
  for(let x=32;x<512;x+=32)for(let y=32;y<384;y+=32){ctx.beginPath();ctx.arc(x*scale,y*scale,1,0,Math.PI*2);ctx.stroke();}
  for(const object of [...value.objects].reverse()) {
    const until=object.time-time;
    if(object.result!==null||until>value.approach_ms||time>object.end_time+value.windows[2])continue;
    const x=object.x*scale,y=object.y*scale,r=value.radius*scale;
    if(object.kind==='spinner') {
      ctx.strokeStyle='#aba5fa';ctx.lineWidth=4;ctx.beginPath();ctx.arc(256*scale,192*scale,135*scale,0,Math.PI*2);ctx.stroke();
      ctx.strokeStyle='#92dec6';ctx.beginPath();ctx.arc(256*scale,192*scale,120*scale,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,Math.min(1,(time-object.time)/(object.end_time-object.time))));ctx.stroke();continue;
    }
    if(object.kind==='slider') {
      ctx.strokeStyle='#aba5fa55';ctx.lineWidth=r*2;ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();object.path.forEach((point,index)=>index?ctx.lineTo(point[0]*scale,point[1]*scale):ctx.moveTo(point[0]*scale,point[1]*scale));ctx.stroke();
      if(time>=object.time){const ball=sliderPosition(object,time);ctx.strokeStyle='#f3f4fa';ctx.lineWidth=3;ctx.beginPath();ctx.arc(ball[0]*scale,ball[1]*scale,r,0,Math.PI*2);ctx.stroke();}
    }
    if(until < -value.windows[2])continue;
    ctx.fillStyle='#aba5fa24';ctx.strokeStyle='#aba5fa';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();ctx.stroke();
    const approach=r*(1+2*Math.max(0,until)/value.approach_ms);
    ctx.strokeStyle='#aba5fa88';ctx.beginPath();ctx.arc(x,y,approach,0,Math.PI*2);ctx.stroke();
  }
  function cursor(position,color,radius){ctx.fillStyle=color;ctx.beginPath();ctx.arc(position[0]*scale,position[1]*scale,radius,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#10182e';ctx.lineWidth=2;ctx.stroke();}
  if(bot)cursor(bot,'#f187b8',7);
  if(humanPointer)cursor(humanPointer,'#92dec6',7);
  const event=value.last_judgment;
  if(event && time-event.time<300){ctx.font='bold 19px Verdana';ctx.textAlign='center';ctx.fillStyle=event.result?'#f3f4fa':'#f187b8';ctx.fillText(event.result || 'Miss',event.x*scale,event.y*scale);}
  ctx.restore();
}
async function pollStatus() {
  if(statusBusy || document.hidden)return;statusBusy=true;
  try {state=await api('api/status');displayStatus();if(pendingAttempt){const data=await api('api/attempt');if(data.id===pendingAttempt.id){attempt=data;const challenge=pendingAttempt.challenge;pendingAttempt=null;$('watch').disabled=$('challenge').disabled=false;playAttempt(challenge);}}}
  catch(e){error(`Unable to reach the app: ${e.message}`);}finally{statusBusy=false;}
}
async function pollScene() {
  if(sceneBusy || document.hidden || mode!=='live' || !state.worker_running)return;sceneBusy=true;
  try{scene=await api('api/scene');if(scene.objects){$('field-empty').hidden=true;$('view-label').textContent='Live exploration';if($('pixels').checked){const response=await fetch(new URL(`api/frame?t=${Date.now()}`,location.href));if(response.ok){pixels=await createImageBitmap(await response.blob());ctx.imageSmoothingEnabled=false;const viewport=fieldViewport(),view=state.observation_view;clearField();
                  const imageScale=viewport.scale/view.scale;
                  if(pixels.width===view.width&&pixels.height===view.height)ctx.drawImage(pixels,viewport.x-view.offset_x*imageScale,viewport.y-view.offset_y*imageScale,view.width*imageScale,view.height*imageScale);pixels.close();}}else drawScene(scene);$('attempt-score').textContent=`${scene.hits} / ${scene.objects.length} objects`;}}
  catch{}finally{sceneBusy=false;}
}
async function requestAttempt(challenge=false) {
  error('');stopPlayback();mode='waiting';$('watch').disabled=$('challenge').disabled=true;
  $('view-label').textContent='Recording a fresh attempt';$('attempt-note').textContent=state.worker_running?'The current training update finishes first. Then the learner records an attempt.':'The learner is recording one attempt from its saved weights.';
  const choice=$('pattern').value,data={};if(choice.startsWith('map:'))data.map_id=choice.slice(4);
  try{pendingAttempt={...await api('api/watch',data),challenge};}
  catch(e){error(e.message);mode='live';$('watch').disabled=$('challenge').disabled=false;}
}
function playAttempt(challenge=false) {
  stopPlayback();mode=challenge?'challenge':'playback';$('field-empty').hidden=true;$('human-legend').hidden=!challenge;
  $('view-label').textContent=challenge?'You and the rival':'Recorded attempt';$('pixels').checked=false;
  $('attempt-note').textContent=challenge?'Move the cursor over the field and press Z or X, or tap a circle. You and the rival play the same real map section.':`${attempt.title}, recorded after ${fmt(attempt.updates)} training updates. Practice results stay here.`;
  if(challenge){human={objects:structuredClone(attempt.scene.objects),points:0,hits:0,keyState:0,windows:attempt.scene.windows,time:0};
    let count=3;$('countdown').textContent=count;$('countdown').hidden=false;drawScene(attempt.scene,0,null,pointer);
    countdownTimer=setInterval(()=>{count--;if(count){$('countdown').textContent=count;}else{clearInterval(countdownTimer);$('countdown').hidden=true;playbackStart=performance.now();animation=requestAnimationFrame(playFrame);}},700);
  } else {playbackStart=performance.now();animation=requestAnimationFrame(playFrame);}
}
function playFrame(now) {
  const time=now-playbackStart,frames=attempt.frames;
  let index=0;while(index<frames.length-1 && frames[index+1][0]<=time)index++;
  const frame=frames[index];
  if(human){while(human.time<=time){humanStep();human.time+=1000/60;}}
  const visible={...attempt.scene,objects:human?human.objects:attempt.scene.objects.map(object=>({...object,result:attempt.events.find(event=>event.id===object.id&&event.time<=time)?.result??null}))};
  drawScene(visible,time,[frame[1],frame[2]],human?pointer:null);
  $('attempt-score').textContent=human?`You: ${human.hits} / ${attempt.summary.objects}`:`Rival: ${percent(attempt.summary.accuracy)} accuracy`;
  if(time>=frames.at(-1)[0]) {
    if(human){const accuracy=human.points/(300*attempt.summary.objects);$('result-title').textContent=accuracy>attempt.summary.accuracy?'You win.':accuracy<attempt.summary.accuracy?'Rival wins.':'A draw.';$('result-detail').textContent=`You ${percent(accuracy)} accuracy. Rival ${percent(attempt.summary.accuracy)} accuracy.`;$('field-result').hidden=false;}
    $('view-label').textContent=human?'Practice finished':'Attempt finished';return;
  }
  animation=requestAnimationFrame(playFrame);
}
function sliderPosition(object,time) {
  const progress=Math.max(0,Math.min(object.repeats,(time-object.time)/object.span));
  const repeat=Math.min(object.repeats-1,Math.floor(progress));let fraction=progress-repeat;
  if(repeat%2)fraction=1-fraction;
  const distance=fraction*object.length;
  let index=1;while(index<object.distances.length-1&&object.distances[index]<distance)index++;
  if(object.path.length===1)return object.path[0];
  fraction=(distance-object.distances[index-1])/Math.max(1e-6,object.distances[index]-object.distances[index-1]);
  return object.path[index-1].map((value,axis)=>value+fraction*(object.path[index][axis]-value));
}
function humanStep() {
  const keys=pressed|mouseHeld,rising=keys&~human.keyState,time=human.time,next=time+1000/60;
  human.keyState=keys;
  function judge(object,result){object.result=result;human.points+=result;if(result)human.hits++;}
  if(rising)for(const object of human.objects){
    if(object.result!==null||object.kind==='spinner'||object.head!==null)continue;
    const error=Math.abs(time-object.time);
    if(error<=human.windows[2]&&Math.hypot(pointer[0]-object.x,pointer[1]-object.y)<=attempt.scene.radius){
      const result=error<=human.windows[0]?300:error<=human.windows[1]?100:50;
      if(object.kind==='circle')judge(object,result);else{object.head=result;object.components_hit++;}
    }break;
  }
  for(const object of human.objects){
    if(object.result!==null)continue;
    if(object.kind==='circle'&&next>object.time+human.windows[2])judge(object,0);
    else if(object.kind==='slider'){
      if(object.head===null&&next>object.time+human.windows[2])object.head=0;
      while(object.checkpoint_index<object.checkpoints.length&&object.checkpoints[object.checkpoint_index]<=next){
        const target=sliderPosition(object,object.checkpoints[object.checkpoint_index]);
        if(keys&&Math.hypot(pointer[0]-target[0],pointer[1]-target[1])<=attempt.scene.radius*2.4)object.components_hit++;
        object.checkpoint_index++;
      }
      if(next>=Math.max(object.end_time,object.time+human.windows[2])){const fraction=object.components_hit/(1+object.checkpoints.length);judge(object,fraction===1?300:fraction>=.5?100:fraction>0?50:0);}
    }else if(object.kind==='spinner'){
      if(time>=object.time&&time<object.end_time){
        const dx=pointer[0]-256,dy=pointer[1]-192,angle=Math.atan2(dy,dx);
        if(keys&&Math.hypot(dx,dy)>=24){if(object.last_angle!==null){const delta=Math.abs(((angle-object.last_angle+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI);object.rotation+=Math.min(delta,.5);}object.last_angle=angle;}else object.last_angle=null;
      }
      if(next>=object.end_time){const map=state.maps.find(item=>item.id===attempt.scene.map.id),required=Math.max(1,(object.end_time-object.time)/1000*(3+(map?.od??5)*.2));const fraction=object.rotation/(2*Math.PI*required);judge(object,fraction>=1?300:fraction>=.9?100:fraction>=.75?50:0);}
    }
  }
}
function movePointer(event){
  const box=field.getBoundingClientRect(),viewport=fieldViewport();
  const x=(event.clientX-box.left)/box.width*field.width;
  const y=(event.clientY-box.top)/box.height*field.height;
  pointer=[Math.max(0,Math.min(512,(x-viewport.x)/viewport.scale)),Math.max(0,Math.min(384,(y-viewport.y)/viewport.scale))];
}
field.addEventListener('pointermove',movePointer);
field.addEventListener('pointerdown',event=>{movePointer(event);mouseHeld=1;field.setPointerCapture(event.pointerId);});
field.addEventListener('pointerup',()=>{mouseHeld=0;});field.addEventListener('pointercancel',()=>{mouseHeld=0;});
document.addEventListener('keydown',event=>{if(!human||!['z','x'].includes(event.key.toLowerCase())||event.repeat||['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))return;event.preventDefault();pressed|=event.key.toLowerCase()==='z'?1:2;});
document.addEventListener('keyup',event=>{if(event.key.toLowerCase()==='z')pressed&=~1;if(event.key.toLowerCase()==='x')pressed&=~2;});
window.addEventListener('blur',()=>{pressed=mouseHeld=0;});
$('train').addEventListener('click',async()=>{const button=$('train');button.disabled=true;error('');try{const running=state.worker_running && state.status!=='watching';state=await api(`api/training/${running?'pause':'start'}`,{});if(!running){stopPlayback();mode='live';}displayStatus();}catch(e){error(e.message);}finally{button.disabled=false;}});
$('watch').addEventListener('click',()=>requestAttempt(false));$('challenge').addEventListener('click',()=>requestAttempt(true));$('try-again').addEventListener('click',()=>playAttempt(true));
$('pixels').addEventListener('change',()=>{if(mode==='playback'||mode==='challenge'){stopPlayback();mode='live';}pollScene();});
$('sync-maps').addEventListener('click',async()=>{error('');try{await api('api/maps/sync',{});await pollStatus();}catch(e){error(e.message);}});
$('map-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;error('');try{if(file.size>2*1024*1024)throw new Error('Choose a .osu file smaller than 2 MB.');const map=await api('api/maps',{text:await file.text()});$('map-note').textContent=`Imported ${map.title}, ${fmt(map.objects)} objects.`;await pollStatus();$('pattern').value=`map:${map.id}`;}catch(e){error(e.message);}finally{event.target.value='';}});
$('checkpoint-file').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;error('');try{if(file.size>2.9*1024*1024)throw new Error('Choose a checkpoint smaller than 2.9 MB.');const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(let start=0;start<bytes.length;start+=8192)text+=String.fromCharCode(...bytes.subarray(start,start+8192));await api('api/checkpoints/import',{data:btoa(text)});await pollStatus();}catch(e){error(e.message);}finally{event.target.value='';}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){pollStatus();pollScene();}});
window.addEventListener('resize',drawChart);
pollStatus();setInterval(pollStatus,1000);setInterval(pollScene,350);
