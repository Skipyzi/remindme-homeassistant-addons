"""Pixel observations and input rewards on authored osu!standard beatmaps.

The small training judge supports circles, slider checkpoints and spinners.
It is not the native lazer judge and never authorizes leaderboard scores.
"""
from collections import deque
import copy
import math

import numpy as np
from PIL import Image, ImageDraw

from .beatmaps import MapLibrary, parse_beatmap, slider_position

WIDTH, HEIGHT = 64, 48
FRAME_MS = 1000 / 60


class Environment:
    def __init__(self, seed=42, beatmap=None, section=None, library=None, level=0):
        if beatmap is None and library is None and section is None:
            raise ValueError('A real beatmap is required; there is no generated training fallback')
        self.rng = np.random.default_rng(seed)
        self.beatmap, self.section, self.library, self.level = beatmap, section, library, level
        self.frames = deque(maxlen=4)
        self.reset()

    def reset(self):
        if self.library:
            self.beatmap,start,end = self.library.choose(self.rng,self.level)
        elif self.section:
            self.beatmap,start,end = self.section
        else:
            start,end = 0,len(self.beatmap['objects'])
        beatmap = self.beatmap
        self.radius = max(8,54.4-4.48*beatmap['cs'])
        od,ar = beatmap['od'],beatmap['ar']
        self.windows = (80-6*od,140-8*od,200-10*od)
        self.approach_ms = 1200+(5-ar)*(120 if ar<5 else 150)
        self.origin = max(0,beatmap['objects'][start]['time']-self.approach_ms)
        self.objects = copy.deepcopy(beatmap['objects'][start:end])
        for index,obj in enumerate(self.objects):
            obj.update(id=index,result=None,head=None,checkpoint_index=0,components_hit=0,rotation=0.0,last_angle=None)
            obj['time'] -= self.origin; obj['end_time'] -= self.origin
            if obj['kind']=='slider':
                obj['checkpoints'] = [time-self.origin for time in obj['checkpoints']]
        self.time, self.cursor, self.keys = 0.0,[256.0,192.0],0
        self.combo = self.max_combo = self.points = self.components_hit = self.components_missed = 0
        self.results = {'300':0,'100':0,'50':0,'miss':0}
        self.last_judgment = None
        self.events = []
        self.end_time = max(obj['end_time'] for obj in self.objects)+self.windows[-1]+FRAME_MS
        self.frames.clear()
        frame = self.render()
        self.frames.extend(frame.copy() for _ in range(4))
        return self.observation()

    def observation(self):
        # Map data and the simulator clock never enter the network.
        return np.stack(self.frames)

    def step(self, action):
        latent,key_state = action
        position = np.tanh(np.asarray(latent,dtype=np.float32))
        self.cursor = [float((position[0]+1)*256),float((position[1]+1)*192)]
        next_keys = int(key_state)
        if not 0 <= next_keys <= 3:
            raise ValueError('Key state must be between 0 and 3')
        rising = next_keys & ~self.keys
        self.keys, reward = next_keys,0.0
        if rising:
            for obj in self.objects:
                if obj['result'] is not None or obj['kind']=='spinner' or obj['head'] is not None:
                    continue
                error = abs(self.time-obj['time'])
                if error <= self.windows[-1] and math.dist(self.cursor,[obj['x'],obj['y']]) <= self.radius:
                    result = 300 if error <= self.windows[0] else 100 if error <= self.windows[1] else 50
                    if obj['kind']=='circle':
                        reward += self.judge(obj,result)
                    else:
                        obj['head'] = result
                        obj['components_hit'] += 1
                        self.components_hit += 1
                        reward += .1
                break
        following_time = self.time+FRAME_MS
        for obj in self.objects:
            if obj['result'] is not None:
                continue
            kind = obj['kind']
            if kind=='circle' and following_time>obj['time']+self.windows[-1]:
                reward += self.judge(obj,0)
            elif kind=='slider':
                if obj['head'] is None and following_time>obj['time']+self.windows[-1]:
                    obj['head'] = 0; self.components_missed += 1; reward -= .05
                while obj['checkpoint_index']<len(obj['checkpoints']) and obj['checkpoints'][obj['checkpoint_index']]<=following_time:
                    target_time = obj['checkpoints'][obj['checkpoint_index']]
                    target = slider_position(obj,target_time)
                    hit = bool(self.keys and math.dist(self.cursor,target)<=self.radius*2.4)
                    if hit:
                        obj['components_hit'] += 1; self.components_hit += 1; reward += .05
                    else:
                        self.components_missed += 1; reward -= .025
                    obj['checkpoint_index'] += 1
                if following_time>=max(obj['end_time'],obj['time']+self.windows[-1]):
                    fraction = obj['components_hit']/(1+len(obj['checkpoints']))
                    result = 300 if fraction==1 else 100 if fraction>=.5 else 50 if fraction>0 else 0
                    reward += self.judge(obj,result)
            elif kind=='spinner':
                if obj['time']<=self.time<obj['end_time']:
                    dx,dy = self.cursor[0]-256,self.cursor[1]-192
                    angle = math.atan2(dy,dx)
                    if self.keys and math.hypot(dx,dy)>=24:
                        if obj['last_angle'] is not None:
                            delta = abs((angle-obj['last_angle']+math.pi)%(2*math.pi)-math.pi)
                            before = int(obj['rotation']/(2*math.pi))
                            obj['rotation'] += min(delta,.5)
                            reward += .05*(int(obj['rotation']/(2*math.pi))-before)
                        obj['last_angle'] = angle
                    else:
                        obj['last_angle'] = None
                if following_time>=obj['end_time']:
                    required = max(1,(obj['end_time']-obj['time'])/1000*(3+od_rate(self.beatmap['od'])))
                    fraction = obj['rotation']/(2*math.pi*required)
                    result = 300 if fraction>=1 else 100 if fraction>=.9 else 50 if fraction>=.75 else 0
                    reward += self.judge(obj,result)
        self.time = following_time
        done = all(obj['result'] is not None for obj in self.objects) or self.time>=self.end_time
        self.frames.append(self.render())
        return self.observation(),reward,done

    def judge(self,obj,result):
        if obj['result'] is not None:
            raise RuntimeError('An object cannot be judged twice')
        obj['result'] = result
        self.results[str(result) if result else 'miss'] += 1
        self.points += result
        self.combo = self.combo+1 if result else 0
        self.max_combo = max(self.combo,self.max_combo)
        self.last_judgment = {'id':obj['id'],'result':result,'time':round(self.time,2),'x':obj['x'],'y':obj['y']}
        self.events.append(dict(self.last_judgment))
        return result/300 if result else -.5

    def summary(self):
        judged = sum(self.results.values()); hits = judged-self.results['miss']
        return {'objects':len(self.objects),'judged':judged,'hits':hits,'hit_rate':hits/judged if judged else 0,
                'accuracy':self.points/(300*judged) if judged else 0,'points':self.points,'max_combo':self.max_combo,
                'results':dict(self.results),'components_hit':self.components_hit,'components_missed':self.components_missed}

    def scene(self):
        return {**self.summary(),'object_count':len(self.objects),'time':round(self.time,2),'cursor':self.cursor,'keys':self.keys,'radius':self.radius,
                'approach_ms':self.approach_ms,'windows':self.windows,'end_time':self.end_time,
                'objects':copy.deepcopy(self.objects),'last_judgment':self.last_judgment,
                'map':{'id':self.beatmap.get('id'),'beatmap_id':self.beatmap['beatmap_id'],
                       'title':self.beatmap['title'],'difficulty':self.beatmap['difficulty'],
                       'source_sha256':self.beatmap['source_sha256'],'start_ms':self.origin}}

    def render(self):
        image = Image.new('L',(WIDTH,HEIGHT),8); draw = ImageDraw.Draw(image); scale = WIDTH/512
        for obj in reversed(self.objects):
            until = obj['time']-self.time
            if obj['result'] is not None or until>self.approach_ms:
                continue
            x,y,r = obj['x']*scale,obj['y']*scale,self.radius*scale
            if obj['kind']=='spinner':
                if self.time>obj['end_time']:
                    continue
                radius = 17
                draw.ellipse((32-radius,24-radius,32+radius,24+radius),outline=180,width=2)
                progress = max(0,min(1,(self.time-obj['time'])/(obj['end_time']-obj['time'])))
                draw.arc((17,9,47,39),-90,-90+360*progress,fill=240,width=2)
                continue
            if obj['kind']=='slider':
                path = [(point[0]*scale,point[1]*scale) for point in obj['path']]
                draw.line(path,fill=100,width=max(2,round(r*2)),joint='curve')
                if self.time>=obj['time']:
                    ball = slider_position(obj,self.time); bx,by = ball[0]*scale,ball[1]*scale
                    draw.ellipse((bx-r,by-r,bx+r,by+r),outline=255,width=2)
            if obj['head'] is None or obj['kind']=='circle':
                if until < -self.windows[-1]:
                    continue
                draw.ellipse((x-r,y-r,x+r,y+r),fill=65,outline=210,width=1)
                approach = r*(1+2*max(0,until)/self.approach_ms)
                draw.ellipse((x-approach,y-approach,x+approach,y+approach),outline=140,width=1)
        x,y = self.cursor[0]*scale,self.cursor[1]*scale
        draw.ellipse((x-1,y-1,x+1,y+1),fill=255)
        for key in range(2):
            draw.rectangle((1+key*4,HEIGHT-3,3+key*4,HEIGHT-1),fill=230 if self.keys&(1<<key) else 30)
        return np.asarray(image,dtype=np.uint8).copy()


def od_rate(od):
    return od*.2
