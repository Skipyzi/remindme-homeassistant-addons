"""Pixel observations and input rewards on authored osu!standard beatmaps.

The small training judge supports circles, slider checkpoints and spinners.
It is not the native lazer judge and never authorizes leaderboard scores.
"""
from collections import deque
import base64
import copy
import math

import numpy as np
from PIL import Image, ImageDraw

from .beatmaps import MapLibrary, parse_beatmap, slider_position

from .vision import WIDTH,HEIGHT,PADDING,PIXELS_PER_UNIT,view
from .rewards import DISCOUNT,aim_potential
from .rules import REVISION as SCORING_REVISION,hit_windows,update_tracking,spinner_rotation,spinner_result,spinner_progress,TAIL_LENIENCY
FRAME_MS = 1000 / 60


class Environment:
    def __init__(self, seed=42, beatmap=None, section=None, library=None, map_index=0, map_stride=1, reward_feedback=False):
        if beatmap is None and library is None and section is None:
            raise ValueError('A real beatmap is required; there is no generated training fallback')
        self.rng = np.random.default_rng(seed)
        self.reward_feedback=reward_feedback
        self.beatmap, self.section, self.library = beatmap, section, library
        # Parallel training gives each environment its own maps: start on map `map_index`, then every `map_stride`-th.
        self.next_map_index, self.map_stride = map_index, map_stride
        self.frames = deque(maxlen=4)
        self.reset()

    def reset(self):
        if self.library:
            self.beatmap,start,end = self.library.choose(self.next_map_index)
            self.next_map_index += self.map_stride
        elif self.section:
            self.beatmap,start,end = self.section
        else:
            start,end = 0,len(self.beatmap['objects'])
        beatmap = self.beatmap
        self.radius = max(8,54.4-4.48*beatmap['cs'])
        od,ar = beatmap['od'],beatmap['ar']
        self.windows = hit_windows(od)
        self.approach_ms = 1200+(5-ar)*(120 if ar<5 else 150)
        self.origin = max(0,beatmap['objects'][start]['time']-self.approach_ms)
        self.objects = copy.deepcopy(beatmap['objects'][start:end])
        for index,obj in enumerate(self.objects):
            obj.update(id=index,result=None,head=None,checkpoint_index=0,components_hit=0,rotation=0.0,last_angle=None,
                       tracking=False,head_key=0,accept_any_key=True,tail_result=None,
                       spin_accumulated=0.0,spin_completed_at=0.0,spin_max=0.0,spin_count=0)
            obj['time'] -= self.origin; obj['end_time'] -= self.origin
            if obj['kind']=='slider':
                obj['checkpoints'] = [time-self.origin for time in obj['checkpoints']]
        self.time, self.cursor, self.keys = 0.0,[256.0,192.0],0
        self.combo = self.max_combo = self.points = self.components_hit = self.components_missed = 0
        self.results = {'300':0,'100':0,'50':0,'miss':0}
        self.last_judgment = None
        self.events = []
        self.last_reward={'score':0.0,'feedback':0.0}
        self.accuracy_points=self.accuracy_max=0
        self.score_counts={}
        self.scoring_scope='whole-map'
        self.end_time = max(obj['end_time'] for obj in self.objects)+self.windows[-1]+FRAME_MS
        self.active, self.next_object = [],0
        self.activate()
        self.frames.clear()
        frame = self.render()
        self.frames.extend(frame.copy() for _ in range(4))
        return self.observation()

    def observation(self):
        # Map data and the simulator clock never enter the network.
        return np.stack(self.frames)

    def activate(self):
        # Future objects stay out of the per-frame judge and renderer. Long
        # sliders remain active until their final judgment.
        while self.next_object<len(self.objects) and self.objects[self.next_object]['time']<=self.time+self.approach_ms:
            obj=self.objects[self.next_object]
            if obj['result'] is None:self.active.append(obj)
            self.next_object += 1

    def step(self, action):
        potential=aim_potential(self) if self.reward_feedback else 0.0
        latent,key_state = action
        position = np.tanh(np.asarray(latent,dtype=np.float32))
        self.cursor = [float((position[0]+1)*256),float((position[1]+1)*192)]
        next_keys = int(key_state)
        if not 0 <= next_keys <= 3:
            raise ValueError('Key state must be between 0 and 3')
        previous_keys=self.keys
        rising = next_keys & ~previous_keys
        self.keys, reward = next_keys,0.0
        catchup={}
        for bit in (1,2):
            if not rising & bit:continue
            for obj in self.active:
                if obj['result'] is not None or obj['kind']=='spinner' or obj['head'] is not None:continue
                error=abs(self.time-obj['time'])
                if error>400 or math.dist(self.cursor,(obj['x'],obj['y']))>self.radius:continue
                blocking=[old for old in self.active if old['time']<obj['time'] and old['result'] is None
                          and old['kind']!='spinner' and old['head'] is None]
                if blocking and self.time<blocking[-1]['time']:break
                # Default lazer start-time order: after their start, skipped
                # circles/heads are missed instead of blocking later targets.
                for old in blocking:
                    if old['kind']=='circle':reward+=self.judge(old,0)
                    else:
                        old['head']=0;self.components_missed+=1
                        reward+=self.score_part(old,0,300,'head')
                result=300 if error<=self.windows[0] else 100 if error<=self.windows[1] else 50 if error<=self.windows[2] else 0
                if obj['kind']=='circle':reward+=self.judge(obj,result)
                else:
                    obj['head']=result
                    if result:obj['components_hit']+=1;self.components_hit+=1
                    else:self.components_missed+=1
                    obj['head_key']=bit if result else 0
                    obj['accept_any_key']=not bool(previous_keys & (3 ^ bit)) if result else True
                    passed=[i for i in range(obj['checkpoint_index'],len(obj['checkpoints'])) if obj['checkpoints'][i]<=self.time]
                    in_range=math.dist(self.cursor,slider_position(obj,self.time))<=self.radius*2.4
                    all_passed=in_range and all(math.dist(self.cursor,slider_position(obj,obj['checkpoints'][i]))<=self.radius*2.4 for i in passed)
                    if result and passed:catchup[obj['id']]=(passed[-1],all_passed)
                    obj['tracking']=bool(result and (all_passed or math.dist(self.cursor,slider_position(obj,self.time))<=self.radius))
                    reward+=self.score_part(obj,result,300,'head')
                break
        following_time = self.time+FRAME_MS
        for obj in self.active:
            if obj['result'] is not None:
                continue
            kind = obj['kind']
            if kind=='circle' and following_time>obj['time']+self.windows[-1]:
                reward += self.judge(obj,0)
            elif kind=='slider':
                if obj['head'] is None and following_time>obj['time']+self.windows[-1]:
                    obj['head']=0;self.components_missed+=1
                    reward+=self.score_part(obj,0,300,'head')
                if self.time>=obj['time']:
                    update_tracking(obj,self.cursor,self.keys,previous_keys,self.radius,self.time)
                if obj['head'] is not None:
                    while obj['checkpoint_index']<len(obj['checkpoints']):
                        index=obj['checkpoint_index'];target_time=obj['checkpoints'][index]
                        tail=index==len(obj['checkpoints'])-1
                        due=target_time-TAIL_LENIENCY if tail else target_time
                        # Tail leniency starts only after all earlier ticks/repeats were judged.
                        if due>following_time:break
                        event_time=max(self.time,min(target_time,following_time))
                        update_tracking(obj,self.cursor,self.keys,previous_keys,self.radius,event_time)
                        if tail and not obj['tracking'] and following_time<target_time:break
                        forced=catchup.get(obj['id'])
                        hit=forced[1] if forced and index<=forced[0] else obj['tracking'];part='tail' if tail else obj.get('checkpoint_kinds',['tick']*len(obj['checkpoints']))[index]
                        if hit:obj['components_hit']+=1;self.components_hit+=1
                        else:self.components_missed+=1
                        reward+=self.score_part(obj,(150 if tail else 30) if hit else 0,150 if tail else 30,part,
                                                event_time=event_time,position=slider_position(obj,target_time))
                        if tail:obj['tail_result']=150 if hit else 0
                        obj['checkpoint_index']+=1
                if following_time>=max(obj['end_time'],obj['time']+self.windows[-1]) and obj['checkpoint_index']==len(obj['checkpoints']):
                    # Lazer's parent slider has no scoring judgment. Head, ticks,
                    # repeats and tail have already contributed independently.
                    self.complete(obj,obj['head'])
            elif kind=='spinner':
                spinner_rotation(obj,self.cursor,self.keys,self.time)
                if following_time>=obj['end_time']:
                    reward+=self.judge(obj,spinner_result(obj,self.beatmap['od']))
        self.time = following_time
        self.active = [obj for obj in self.active if obj['result'] is None]
        self.activate()
        done = sum(self.results.values())==len(self.objects) or self.time>=self.end_time
        feedback=DISCOUNT*(aim_potential(self) if not done else 0.0)-potential if self.reward_feedback else 0.0
        self.last_reward={'score':reward,'feedback':feedback}
        self.frames.append(self.render())
        return self.observation(),reward+feedback,done

    def complete(self,obj,result):
        if obj['result'] is not None:raise RuntimeError('An object cannot be judged twice')
        obj['result']=result
        self.results[str(result) if result else 'miss']+=1
        self.points+=result
        if obj['kind']=='slider':
            self.events.append({'id':obj['id'],'result':result,'time':round(self.time+FRAME_MS,2),
                                'display_time':round(self.time+FRAME_MS,2),'x':obj['x'],'y':obj['y'],'part':'complete','complete':True,
                                'accuracy_points':0,'accuracy_max':0,'combo_after':self.combo,'max_combo_after':self.max_combo})

    def score_part(self,obj,result,maximum,part,event_time=None,position=None):
        self.accuracy_points+=result;self.accuracy_max+=maximum
        if result:self.combo+=1
        elif part!='tail':self.combo=0
        self.max_combo=max(self.combo,self.max_combo)
        key=f'{part}:{result}';self.score_counts[key]=self.score_counts.get(key,0)+1
        x,y=position or (obj['x'],obj['y'])
        self.last_judgment={'id':obj['id'],'result':result,'time':round(self.time if event_time is None else event_time,2),
                           'display_time':round(self.time+FRAME_MS,2),'x':x,'y':y,'part':part,'complete':part in ('circle','spinner'),
                           'accuracy_points':result,'accuracy_max':maximum,'combo_after':self.combo,'max_combo_after':self.max_combo}
        self.events.append(dict(self.last_judgment))
        return result/300 if result else -maximum/600

    def judge(self,obj,result):
        if obj['result'] is not None:raise RuntimeError('An object cannot be judged twice')
        reward=self.score_part(obj,result,300,obj['kind'])
        self.complete(obj,result)
        return reward

    def summary(self):
        judged = sum(self.results.values()); hits = judged-self.results['miss']
        held={key:count for key,count in self.score_counts.items() if key.split(':')[0] in ('tick','repeat','tail')}
        parts=sum(held.values());parts_hit=sum(count for key,count in held.items() if not key.endswith(':0'))
        return {'objects':len(self.objects),'judged':judged,'hits':hits,'hit_rate':hits/judged if judged else 0,
                'accuracy':self.accuracy_points/self.accuracy_max if self.accuracy_max else 0,
                'points':self.accuracy_points,'accuracy_max':self.accuracy_max,'score_counts':dict(self.score_counts),
                'scoring_revision':SCORING_REVISION,'scoring_scope':self.scoring_scope,'max_combo':self.max_combo,
                'slider_parts_hit':parts_hit,'slider_parts_total':parts,
                'slider_tracking_hit_rate':parts_hit/parts if parts else 0,
                'results':dict(self.results),'components_hit':self.components_hit,'components_missed':self.components_missed}

    def map_info(self):
        return {'id':self.beatmap.get('id'),'beatmap_id':self.beatmap['beatmap_id'],
                'title':self.beatmap['title'],'difficulty':self.beatmap['difficulty'],
                'source_sha256':self.beatmap['source_sha256'],'start_ms':self.origin}

    def progress(self):
        return {'time':round(self.time,2),'end_time':self.end_time,
                'judged':sum(self.results.values()),'object_count':len(self.objects)}

    def save_run(self):
        fields=['result','head','checkpoint_index','components_hit','rotation','last_angle',
                'tracking','head_key','accept_any_key','tail_result','spin_accumulated','spin_completed_at','spin_max','spin_count']
        return {'format':'full-map-run-v1','scoring_revision':SCORING_REVISION,
                'scoring':{'points':self.accuracy_points,'maximum':self.accuracy_max,'counts':self.score_counts,'scope':self.scoring_scope},
                'map_id':self.beatmap.get('id'),
                'source_sha256':self.beatmap['source_sha256'],'time':self.time,
                'cursor':self.cursor,'keys':self.keys,'combo':self.combo,'max_combo':self.max_combo,
                'components_hit':self.components_hit,'components_missed':self.components_missed,
                'objects':[{key:obj[key] for key in fields} for obj in self.objects],
                'frames':base64.b64encode(self.observation().tobytes()).decode('ascii')}

    def restore_run(self,data):
        if data.get('format')!='full-map-run-v1' or not self.library:
            raise ValueError('Invalid saved map run')
        index=next((i for i,(beatmap,_,_) in enumerate(self.library.training)
                    if beatmap['id']==data.get('map_id') and beatmap['source_sha256']==data.get('source_sha256')),None)
        if index is None:raise ValueError('Saved training map is no longer available')
        self.next_map_index=index
        self.reset()
        clock=data.get('time');cursor=data.get('cursor');keys=data.get('keys')
        if type(clock) not in (int,float) or not math.isfinite(clock) or not 0<=clock<=self.end_time:
            raise ValueError('Invalid saved map clock')
        if not isinstance(cursor,list) or len(cursor)!=2 or any(type(value) not in (int,float) or not math.isfinite(value) or not 0<=value<=limit for value,limit in zip(cursor,[512,384])):
            raise ValueError('Invalid saved cursor')
        if type(keys) is not int or not 0<=keys<=3:raise ValueError('Invalid saved keys')
        states=data.get('objects')
        if not isinstance(states,list) or len(states)!=len(self.objects):raise ValueError('Invalid saved object states')
        for obj,saved in zip(self.objects,states):
            legacy_fields={'result','head','checkpoint_index','components_hit','rotation','last_angle'}
            extra_fields={'tracking','head_key','accept_any_key','tail_result','spin_accumulated','spin_completed_at','spin_max','spin_count'}
            if not isinstance(saved,dict) or not legacy_fields<=set(saved) or set(saved)-legacy_fields-extra_fields:
                raise ValueError('Invalid saved object state')
            if any(saved[key] not in (None,0,50,100,300) for key in ['result','head']):raise ValueError('Invalid saved judgment')
            for key in ['checkpoint_index','components_hit']:
                limit=len(obj.get('checkpoints',[]))+(key=='components_hit')
                if type(saved[key]) is not int or not 0<=saved[key]<=limit:raise ValueError('Invalid saved slider progress')
            if data.get('scoring_revision')==SCORING_REVISION:
                if not extra_fields<=set(saved):raise ValueError('Incomplete saved input state')
                if any(type(saved[k]) is not bool for k in ('tracking','accept_any_key')):raise ValueError('Invalid saved tracking state')
                if type(saved['head_key']) is not int or saved['head_key'] not in (0,1,2):raise ValueError('Invalid saved slider key')
                if saved['tail_result'] not in (None,0,150):raise ValueError('Invalid saved slider tail')
                if type(saved['spin_count']) is not int or not 0<=saved['spin_count']<=10**9:raise ValueError('Invalid saved spin count')
                if any(type(saved[k]) not in (int,float) or not math.isfinite(saved[k]) or abs(saved[k])>10**9 for k in ('spin_accumulated','spin_completed_at','spin_max')):
                    raise ValueError('Invalid saved spin history')
            elif set(saved)!=legacy_fields:raise ValueError('Unknown saved scoring fields')
            for key in ['rotation','last_angle']:
                value=saved[key]
                if key=='last_angle' and value is None:continue
                if type(value) not in (int,float) or not math.isfinite(value) or abs(value)>1e9:raise ValueError('Invalid saved spinner progress')
        for key in ['combo','max_combo','components_hit','components_missed']:
            value=data.get(key)
            if type(value) is not int or not 0<=value<=10**9:raise ValueError('Invalid saved map totals')
        try:
            raw=base64.b64decode(data['frames'],validate=True)
        except (ValueError,KeyError,TypeError):raise ValueError('Invalid saved image stack') from None
        if len(raw)!=4*HEIGHT*WIDTH:raise ValueError('Invalid saved image stack')
        for obj,saved in zip(self.objects,states):obj.update(saved)
        if data.get('scoring_revision')==SCORING_REVISION:
            score=data.get('scoring',{})
            if any(type(score.get(key)) is not int or not 0<=score[key]<=10**9 for key in ('points','maximum')) or score['points']>score['maximum']:
                raise ValueError('Invalid saved accuracy totals')
            if not isinstance(score.get('counts'),dict) or any(type(v) is not int or not 0<=v<=10**9 for v in score['counts'].values()):
                raise ValueError('Invalid saved judgment totals')
            self.accuracy_points,self.accuracy_max=score['points'],score['maximum']
            self.score_counts=score['counts'];self.scoring_scope=score.get('scope','whole-map')
            if self.scoring_scope not in ('whole-map','new judgments after rules upgrade'):raise ValueError('Invalid saved score scope')
        else:
            # Past checkpoint-only results cannot be reconstructed as lazer parts.
            # Keep the map position, but grade only new judgments until its next map.
            self.scoring_scope='new judgments after rules upgrade'
            for obj in self.objects:
                if obj['kind']=='slider' and obj['result'] is None:
                    obj['checkpoint_index']=sum(t<=clock for t in obj['checkpoints'])
                    obj['tracking']=False
                if obj['kind']=='spinner' and obj['result'] is None:
                    obj['rotation']=0.;obj['last_angle']=None
        self.results={key:0 for key in ['300','100','50','miss']}
        for obj in self.objects:
            if obj['result'] is not None:self.results[str(obj['result']) if obj['result'] else 'miss']+=1
        self.points=sum(int(key)*count for key,count in self.results.items() if key!='miss')
        self.time,self.cursor,self.keys=clock,list(cursor),keys
        for key in ['components_hit','components_missed']:setattr(self,key,data[key])
        if data.get('scoring_revision')==SCORING_REVISION:
            self.combo,self.max_combo=data['combo'],data['max_combo']
        else:self.combo=self.max_combo=0
        self.active,self.next_object=[],0
        self.activate()
        self.frames.clear()
        self.frames.extend(frame.copy() for frame in np.frombuffer(raw,dtype=np.uint8).reshape(4,HEIGHT,WIDTH))

    def scene(self,visible_only=False):
        return {**self.summary(),'object_count':len(self.objects),'time':round(self.time,2),'cursor':self.cursor,'keys':self.keys,'combo':self.combo,'radius':self.radius,
                'observation_view':view(),'approach_ms':self.approach_ms,'windows':self.windows,'end_time':self.end_time,
                'objects':copy.deepcopy(self.active if visible_only else self.objects),'last_judgment':self.last_judgment,
                'map':self.map_info(),'od':self.beatmap['od'],'judgments':copy.deepcopy(self.events[-256:])}

    def render(self):
        image = Image.new('L',(WIDTH,HEIGHT),8); draw = ImageDraw.Draw(image); scale = PIXELS_PER_UNIT
        for obj in reversed(self.active):
            until = obj['time']-self.time
            if obj['result'] is not None or until>self.approach_ms:
                continue
            x,y,r = obj['x']*scale+PADDING,obj['y']*scale+PADDING,self.radius*scale
            if obj['kind']=='spinner':
                if self.time>obj['end_time']:
                    continue
                radius = 17
                draw.ellipse((32+PADDING-radius,24+PADDING-radius,32+PADDING+radius,24+PADDING+radius),outline=180,width=2)
                progress = max(0,min(1,spinner_progress(obj,self.beatmap['od'])))
                draw.arc((17+PADDING,9+PADDING,47+PADDING,39+PADDING),-90,-90+360*progress,fill=240,width=2)
                continue
            if obj['kind']=='slider':
                path = [(point[0]*scale+PADDING,point[1]*scale+PADDING) for point in obj['path']]
                draw.line(path,fill=100,width=max(2,round(r*2)),joint='curve')
                if self.time>=obj['time']:
                    ball = slider_position(obj,self.time); bx,by = ball[0]*scale+PADDING,ball[1]*scale+PADDING
                    draw.ellipse((bx-r,by-r,bx+r,by+r),outline=255,width=2)
                    if obj['tracking']:
                        follow=r*2.4
                        draw.ellipse((bx-follow,by-follow,bx+follow,by+follow),outline=160,width=1)
            if obj['head'] is None or obj['kind']=='circle':
                if until < -self.windows[-1]:
                    continue
                draw.ellipse((x-r,y-r,x+r,y+r),fill=65,outline=210,width=1)
                approach = r*(1+2*max(0,until)/self.approach_ms)
                draw.ellipse((x-approach,y-approach,x+approach,y+approach),outline=140,width=1)
        x,y = self.cursor[0]*scale+PADDING,self.cursor[1]*scale+PADDING
        draw.ellipse((x-1,y-1,x+1,y+1),fill=255)
        for key in range(2):
            draw.rectangle((1+key*4+PADDING,45+PADDING,3+key*4+PADDING,47+PADDING),fill=230 if self.keys&(1<<key) else 30)
        return np.asarray(image,dtype=np.uint8).copy()
