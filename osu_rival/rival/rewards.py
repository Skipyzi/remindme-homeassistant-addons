"""Bounded progress feedback from the real map judge; never part of the policy input."""
import math
from .beatmaps import slider_position

DISCOUNT=.99
REVISION='aim-progress-v1'


def aim_potential(env):
    # Only visible, unfinished objects contribute. A completed run has zero potential.
    for obj in env.active:
        if obj['result'] is not None or obj['kind']=='spinner':continue
        if obj['kind']=='slider' and env.time>=obj['time']:
            target=slider_position(obj,min(env.time,obj['end_time']));timing=1.0
        else:
            target=(obj['x'],obj['y'])
            timing=max(.2,1-abs(obj['time']-env.time)/max(1,env.approach_ms+env.windows[-1]))
        distance=math.dist(env.cursor,target)
        return timing/(1+(distance/max(1,4*env.radius))**2)
    return 0.0
