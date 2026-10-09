"""Full-map stacking port from osu!lazer's OsuBeatmapProcessor.

See THIRD_PARTY_NOTICES.md. Stacking changes displayed positions, not map timing.
"""
import math


def apply_stacking(beatmap):
    objects=beatmap['objects'];heights=[0]*len(objects)
    approach=1200+(5-beatmap['ar'])*(120 if beatmap['ar']<5 else 150)
    threshold=int(approach)*beatmap['stack_leniency']
    position=lambda obj:(obj['x'],obj['y'])
    end=lambda obj:obj['path'][0 if obj['repeats']%2==0 else -1] if obj['kind']=='slider' else position(obj)
    if beatmap['file_version']>=6:
        for i in range(len(objects)-1,0,-1):
            if heights[i] or objects[i]['kind']=='spinner':continue
            current=i;n=i-1
            if objects[current]['kind']=='circle':
                while n>=0:
                    old=objects[n]
                    if old['kind']=='spinner':n-=1;continue
                    if int(objects[current]['time'])-int(old['end_time'])>threshold:break
                    if old['kind']=='slider' and math.dist(end(old),position(objects[current]))<3:
                        offset=heights[current]-heights[n]+1
                        for j in range(n+1,i+1):
                            if math.dist(end(old),position(objects[j]))<3:heights[j]-=offset
                        break
                    if math.dist(position(old),position(objects[current]))<3:
                        heights[n]=heights[current]+1;current=n
                    n-=1
            else:
                while n>=0:
                    old=objects[n]
                    if old['kind']=='spinner':n-=1;continue
                    if objects[current]['time']-old['time']>threshold:break
                    if math.dist(end(old),position(objects[current]))<3:
                        heights[n]=heights[current]+1;current=n
                    n-=1
    else:
        for i,obj in enumerate(objects):
            if heights[i] and obj['kind']!='slider':continue
            start=obj['end_time'];slider_stack=0
            endpoint=obj['path'][-1] if obj['kind']=='slider' else position(obj)
            for j in range(i+1,len(objects)):
                other=objects[j]
                if other['time']-threshold>start:break
                if math.dist(position(other),position(obj))<3:
                    heights[i]+=1;start=other['time']
                elif math.dist(position(other),endpoint)<3:
                    slider_stack+=1;heights[j]-=slider_stack;start=other['time']
    radius=54.4-4.48*beatmap['cs']
    for obj,height in zip(objects,heights):
        obj['stack_height']=height;obj['authored_position']=[obj['x'],obj['y']]
        offset=-height*radius*.1
        obj['x']+=offset;obj['y']+=offset
        if obj['kind']=='slider':obj['path']=[[x+offset,y+offset] for x,y in obj['path']]
