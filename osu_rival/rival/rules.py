"""Ports of default osu!lazer input/judgment rules for the practice environment.

Algorithm ports from ppy/osu, revision 7e25f111466f1b5648d86856e5737d852402effe.
See THIRD_PARTY_NOTICES.md for source paths, scope and MIT attribution.
"""
import math
from .beatmaps import slider_position

REVISION='lazer-standard-v1'
FOLLOW_AREA=2.4
TAIL_LENIENCY=36.0


def hit_windows(od):
    return tuple(math.floor(a-b*od)-.5 for a,b in ((80,6),(140,8),(200,10)))


def update_tracking(obj,cursor,keys,previous_keys,radius,time):
    if obj['head_key'] and not obj['accept_any_key']:
        if not previous_keys & (3 ^ obj['head_key']):obj['accept_any_key']=True
    action=keys if obj['accept_any_key'] or not obj['head_key'] else keys & obj['head_key']
    target=slider_position(obj,time)
    reach=radius*(FOLLOW_AREA if obj['tracking'] else 1)
    obj['tracking']=bool(action and math.dist(cursor,target)<=reach)
    return obj['tracking']


def spinner_rotation(obj,cursor,keys,time):
    # Native history counts signed motion within each spin. Reversing direction
    # must unwind the partial spin; oscillating cannot accumulate free rotations.
    angle=math.atan2(cursor[1]-192,cursor[0]-256)
    if obj['last_angle'] is not None and keys and obj['time']<=time<obj['end_time']:
        delta=angle-obj['last_angle']
        if delta>math.pi:delta-=2*math.pi
        if delta<-math.pi:delta+=2*math.pi
        report_spinner_delta(obj,delta)
    obj['last_angle']=angle


def report_spinner_delta(obj,delta):
    obj['spin_accumulated']+=delta
    partial=obj['spin_accumulated']-obj['spin_completed_at']
    obj['spin_max']=max(obj['spin_max'],abs(partial))
    while obj['spin_max']>=2*math.pi:
        obj['spin_count']+=1
        obj['spin_completed_at']+=math.copysign(2*math.pi,partial)
        partial=obj['spin_accumulated']-obj['spin_completed_at']
        obj['spin_max']=abs(partial)
    obj['rotation']=obj['spin_count']*2*math.pi+obj['spin_max']


def spinner_progress(obj,od):
    rpm=90+12*od if od<5 else 150+15*(od-5)
    required=int(rpm/60*((obj['end_time']-obj['time'])/1000)+.0001)
    return obj['rotation']/(2*math.pi*required) if required else 1


def spinner_result(obj,od):
    progress=spinner_progress(obj,od)
    return 300 if progress>=1 else 100 if progress>.9 else 50 if progress>.75 else 0
