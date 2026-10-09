"""Compare Python and browser judges on authored maps, using verification inputs only."""
import argparse
import json,subprocess,base64,math
from pathlib import Path
import numpy as np
from rival.beatmaps import parse_beatmap,slider_position
from rival.environment import Environment,FRAME_MS

parser=argparse.ArgumentParser();parser.add_argument('--maps',required=True);parser.add_argument('--report',required=True);args=parser.parse_args()
rng=np.random.default_rng(77);reports=[]
module=(Path(__file__).resolve().parents[1]/'web/rules.js').read_bytes()
url='data:text/javascript;base64,'+base64.b64encode(module).decode()
script="""let body='';for await(const piece of process.stdin)body+=piece;const {scene,actions,sceneChecks}=JSON.parse(body);const {createJudge,sceneAt}=await import(process.argv[1]);const engine=createJudge(scene);const snapshots=[];for(let i=0;i<actions.length;i++){engine.step(actions[i][0],actions[i][1]);if(i%32===0||i===actions.length-1)snapshots.push({points:engine.points,maximum:engine.accuracyMax,combo:engine.combo,best:engine.best,hits:engine.hits,tracking:engine.objects.filter(o=>o.tracking&&o.result===null).map(o=>o.id)});}for(const [a,b] of sceneChecks){const shown=sceneAt(a,b,b.time,b.cursor,b.keys);for(const key of ['points','accuracy_max','combo','max_combo','judged','hits'])if(shown[key]!==b[key])throw new Error('Live scene mismatch: '+key+' '+shown[key]+' != '+b[key]);}process.stdout.write(JSON.stringify({snapshots,events:engine.events,sceneChecks:sceneChecks.length}));"""
for file in sorted(Path(args.maps).glob('*.osu')):
    beatmap=parse_beatmap(file.read_text(encoding='utf-8-sig'));env=Environment(beatmap=beatmap);scene=env.scene();actions=[];expected=[];scene_checks=[];previous_scene=env.scene(visible_only=True)
    while env.time<env.end_time:
        active=[o for o in env.active if o['result'] is None and o['kind']!='spinner']
        selected=next((o for o in active if o['kind']=='slider' and o['head'] is not None and env.time>=o['time']),active[0] if active else None)
        if selected and rng.random()<.75:
            position=slider_position(selected,env.time+FRAME_MS) if selected['kind']=='slider' and env.time>=selected['time'] else (selected['x'],selected['y'])
            keys=1 if selected['head'] is not None else 0 if env.keys else 1
        else:position=rng.uniform([0,0],[512,384]);keys=int(rng.integers(4))
        latent=np.arctanh(np.clip(np.array(position)/[256,192]-1,-.999999,.999999));env.step((latent,keys));actions.append([env.cursor,keys])
        if len(actions)%320==0:
            current_scene=env.scene(visible_only=True);scene_checks.append([previous_scene,current_scene]);previous_scene=current_scene
        if (len(actions)-1)%32==0:expected.append({'points':env.accuracy_points,'maximum':env.accuracy_max,'combo':env.combo,'best':env.max_combo,'hits':env.summary()['hits'],'tracking':[o['id'] for o in env.active if o['tracking']]})
    if (len(actions)-1)%32!=0:expected.append({'points':env.accuracy_points,'maximum':env.accuracy_max,'combo':env.combo,'best':env.max_combo,'hits':env.summary()['hits'],'tracking':[o['id'] for o in env.active if o['tracking']]})
    result=subprocess.run(['node','--input-type=module','-e',script,url],input=json.dumps({'scene':scene,'actions':actions,'sceneChecks':scene_checks}),capture_output=True,text=True,check=True)
    actual=json.loads(result.stdout)
    for index,(a,b) in enumerate(zip(expected,actual['snapshots'])):assert a==b,(file.name,index,a,b)
    assert len(expected)==len(actual['snapshots'])
    assert len(env.events)==len(actual['events'])
    for a,b in zip(env.events,actual['events']):
        for key in ('id','result','part','complete','accuracy_points','accuracy_max','combo_after','max_combo_after'):assert a[key]==b[key],(file.name,key,a,b)
        assert abs(a['time']-b['time'])<.011
    reports.append({'map':file.name,'source_sha256':beatmap['source_sha256'],'objects':len(env.objects),'steps':len(actions),'compared_snapshots':len(expected),'matched_events':len(env.events),'matched_live_scene_intervals':actual['sceneChecks'],'summary':env.summary()})
    print(file.name,'matched',len(actions),'steps,',len(env.events),'events',flush=True)
Path(args.report).write_text(json.dumps({'scoring_revision':'lazer-standard-v1','seed':77,'source':'Authored .osu fixtures; verification actions only, not training demonstrations.','upstream_revision':'7e25f111466f1b5648d86856e5737d852402effe','cases':reports,'limits':'Python/JavaScript port parity and upstream unit-vector checks, not an end-to-end native client comparison.'},indent=2)+'\n')
