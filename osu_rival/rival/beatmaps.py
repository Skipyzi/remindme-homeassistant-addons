"""Decode real osu!standard files and retain their authored geometry and timing."""
import bisect
import hashlib
import math
from pathlib import Path

import numpy as np

from .storage import read_json

MAX_BYTES = 2 * 1024 * 1024


def finite(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('Non-finite number in beatmap')
    return value


def bezier(points):
    points = np.asarray(points, dtype=np.float64)
    t = np.linspace(0, 1, min(257, max(17, len(points)*24)))[:, None, None]
    values = np.broadcast_to(points, (len(t), *points.shape)).copy()
    for size in range(len(points)-1, 0, -1):
        values = values[:, :size]*(1-t) + values[:, 1:size+1]*t
    return values[:, 0].tolist()


def curve(points, kind, length):
    """Sample the declared path, including split Beziers and perfect arcs.

    This is a lightweight training renderer, not the native osu! path engine.
    """
    if kind == 'L':
        sampled = points
    elif kind == 'P' and len(points) == 3:
        a, b, c = np.asarray(points, dtype=np.float64)
        u,v = b-a,c-a
        determinant = 2*(u[0]*v[1]-u[1]*v[0])
        if abs(determinant) < 1e-6:
            sampled = points
        else:
            u, v = b-a, c-a
            centre = a + np.array([v[1]*np.dot(u,u)-u[1]*np.dot(v,v),
                                  u[0]*np.dot(v,v)-v[0]*np.dot(u,u)])/determinant
            angles = [math.atan2(*(p-centre)[::-1]) for p in (a,b,c)]
            sweep = (angles[2]-angles[0]) % (2*math.pi)
            if (angles[1]-angles[0]) % (2*math.pi) > sweep:
                sweep -= 2*math.pi
            radius = float(np.linalg.norm(a-centre))
            sampled = [(centre + radius*np.array([math.cos(t), math.sin(t)])).tolist()
                       for t in np.linspace(angles[0], angles[0]+sweep, min(2049, max(17, int(abs(sweep)*radius/3)+1)))]
    elif kind == 'C':
        sampled = []
        for index in range(len(points)-1):
            p1,p2 = np.array(points[index]),np.array(points[index+1])
            p0 = np.array(points[index-1]) if index else p1
            p3 = np.array(points[index+2]) if index+2 < len(points) else 2*p2-p1
            for t in np.linspace(0,1,33):
                sampled.append((.5*((2*p1)+(-p0+p2)*t+(2*p0-5*p1+4*p2-p3)*t*t+(-p0+3*p1-3*p2+p3)*t*t*t)).tolist())
    else:
        sampled, start = [], 0
        for index in range(1,len(points)):
            if points[index] == points[index-1]:
                sampled.extend(bezier(points[start:index]))
                start = index
        sampled.extend(bezier(points[start:]))
    path, distances = [list(sampled[0])], [0.0]
    for point in sampled[1:]:
        distance = math.dist(path[-1], point)
        if distance < 1e-7:
            continue
        if distances[-1]+distance >= length:
            fraction = (length-distances[-1])/distance
            path.append([path[-1][i]+fraction*(point[i]-path[-1][i]) for i in range(2)])
            distances.append(length)
            break
        path.append(list(point)); distances.append(distances[-1]+distance)
    if distances[-1] < length and len(path) > 1:
        distance = math.dist(path[-2],path[-1])
        fraction = (length-distances[-1])/distance
        path.append([path[-1][i]+fraction*(path[-1][i]-path[-2][i]) for i in range(2)])
        distances.append(length)
    return path, distances


def parse_beatmap(text):
    if len(text.encode()) > MAX_BYTES:
        raise ValueError('Beatmap is larger than 2 MB')
    if not text.lstrip('\ufeff').startswith('osu file format v'):
        raise ValueError('Expected an original .osu beatmap file')
    section, previous = '', -math.inf
    data = {'title':'Imported map','artist':'','difficulty':'','beatmap_id':0,
            'cs':5.0,'od':5.0,'ar':5.0,'slider_multiplier':1.4,'tick_rate':1.0,
            'objects':[],'counts':{'circle':0,'slider':0,'spinner':0},
            'source_sha256':hashlib.sha256(text.encode()).hexdigest(), 'format':'real-beatmap-v1'}
    timing, raw_objects, has_ar = [], [], False
    for raw in text.lstrip('\ufeff').splitlines():
        line = raw.strip()
        if not line or line.startswith('//'):
            continue
        if line.startswith('['):
            section = line; continue
        if section in ('[General]','[Metadata]','[Difficulty]') and ':' in line:
            key,value = (part.strip() for part in line.split(':',1))
            if section == '[General]' and key == 'Mode' and int(value) != 0:
                raise ValueError('Only osu!standard maps are supported')
            target = {'Title':'title','Artist':'artist','Version':'difficulty','BeatmapID':'beatmap_id'}.get(key)
            if section == '[Metadata]' and target:
                data[target] = int(value) if target == 'beatmap_id' else value[:200]
            target = {'CircleSize':'cs','OverallDifficulty':'od','ApproachRate':'ar',
                      'SliderMultiplier':'slider_multiplier','SliderTickRate':'tick_rate'}.get(key)
            if section == '[Difficulty]' and target:
                number = finite(value)
                low, high = (.1,10) if target in ('slider_multiplier','tick_rate') else (0,10)
                if not low <= number <= high:
                    raise ValueError('Difficulty value is outside supported bounds')
                data[target] = number
                has_ar |= target == 'ar'
        elif section == '[TimingPoints]':
            fields = line.split(',')
            point = (finite(fields[0]),finite(fields[1]),len(fields)<7 or fields[6]=='1')
            if point[1] == 0 or (point[2] and point[1] <= 0):
                raise ValueError('Invalid timing point')
            timing.append(point)
        elif section == '[HitObjects]':
            raw_objects.append(line.split(','))
            if len(raw_objects) > 10000:
                raise ValueError('Maximum 10,000 objects per map')
    if not has_ar:
        data['ar'] = data['od']
    timing.sort(key=lambda point:point[0])
    beat_length, velocity, timing_index = 500.0, 1.0, 0
    for fields in raw_objects:
        if len(fields) < 5:
            raise ValueError('Invalid hit object')
        x,y,start,kind = finite(fields[0]),finite(fields[1]),finite(fields[2]),int(fields[3])
        if not -512 <= x <= 1024 or not -384 <= y <= 768 or start < 0 or start < previous:
            raise ValueError('Invalid object coordinates or ordering')
        previous = start
        while timing_index < len(timing) and timing[timing_index][0] <= start:
            _,value,red = timing[timing_index]
            if red:
                beat_length,velocity = value,1.0
            else:
                velocity = min(10,max(.1,-100/value)) if value < 0 else 1.0
            timing_index += 1
        obj = {'x':x,'y':y,'time':start,'end_time':start}
        if kind & 2:
            if len(fields) < 8:
                raise ValueError('Invalid slider')
            parts = fields[5].split('|')
            if parts[0] not in ('B','L','P','C') or len(parts) > 129:
                raise ValueError('Unsupported or oversized slider path')
            points = [[x,y]]
            for point in parts[1:]:
                pair = [finite(value) for value in point.split(':')]
                if len(pair)!=2 or any(abs(value)>10000 for value in pair):
                    raise ValueError('Invalid slider control point')
                points.append(pair)
            repeats,length = int(fields[6]),finite(fields[7])
            if not 1 <= repeats <= 128 or not 0 < length <= 10000 or len(points)<2:
                raise ValueError('Invalid slider length or repeats')
            span = length/(100*data['slider_multiplier']*velocity)*beat_length
            if not 0 < span*repeats <= 120000:
                raise ValueError('Slider duration exceeds two minutes')
            path,distances = curve(points,parts[0],length)
            checkpoints = []
            tick_interval = beat_length/data['tick_rate']
            for repeat in range(repeats):
                tick = tick_interval
                while tick < span-10:
                    checkpoints.append(start+repeat*span+tick)
                    tick += tick_interval
                    if len(checkpoints)>10000:
                        raise ValueError('Too many slider ticks')
                checkpoints.append(start+(repeat+1)*span)
            obj.update(kind='slider',path=path,distances=distances,length=length,
                       repeats=repeats,span=span,end_time=start+span*repeats,checkpoints=checkpoints)
        elif kind & 8:
            end = finite(fields[5])
            if not 0 < end-start <= 120000:
                raise ValueError('Invalid spinner duration')
            obj.update(kind='spinner',x=256.0,y=192.0,end_time=end)
        elif kind & 1 and not kind & 128:
            obj['kind'] = 'circle'
        else:
            raise ValueError('Unsupported hit object')
        data['objects'].append(obj); data['counts'][obj['kind']] += 1
    if not data['objects']:
        raise ValueError('No hit objects in beatmap')
    data['duration_ms'] = max(obj['end_time'] for obj in data['objects'])-data['objects'][0]['time']
    if data['duration_ms'] > 20*60*1000:
        raise ValueError('Maximum map length is twenty minutes')
    data['difficulty_order'] = data['od']+data['ar']*.35+len(data['objects'])/max(1,data['duration_ms']/1000)
    return data


def slider_position(obj, time):
    progress = max(0,min(obj['repeats'],(time-obj['time'])/obj['span']))
    repeat = min(obj['repeats']-1,int(progress))
    fraction = progress-repeat
    if repeat % 2:
        fraction = 1-fraction
    distance = fraction*obj['length']
    distances,path = obj['distances'],obj['path']
    index = min(len(path)-1,max(1,bisect.bisect_left(distances,distance)))
    if len(path)==1:
        return path[0]
    before,after = distances[index-1],distances[index]
    fraction = (distance-before)/max(1e-6,after-before)
    return [path[index-1][axis]+fraction*(path[index][axis]-path[index-1][axis]) for axis in range(2)]


class MapLibrary:
    """Consecutive excerpts of real maps, with a fixed withheld map/time split."""
    def __init__(self, directory):
        self.maps = []
        total_bytes = 0
        for path in Path(directory).glob('*.json'):
            total_bytes += path.stat().st_size
            if total_bytes>64*1024*1024:
                raise ValueError('Saved map library exceeds the 64 MB training budget')
            beatmap = read_json(path)
            if beatmap and beatmap.get('format') == 'real-beatmap-v1':
                beatmap['id'] = path.stem
                self.maps.append(beatmap)
        self.maps.sort(key=lambda beatmap:(beatmap['difficulty_order'],beatmap['id']))
        if not self.maps:
            raise ValueError('No real beatmaps loaded. Sync the server cache or import a .osu file first.')
        self.training, self.testing = [], []
        multiple = len(self.maps) >= 2
        withheld = {beatmap['id'] for index,beatmap in enumerate(self.maps) if index%5==4}
        if multiple and not withheld:
            withheld = {self.maps[-1]['id']}
        for beatmap in self.maps:
            objects,groups,start = beatmap['objects'],[],0
            # Boundaries never cut a slider/spinner. No coordinates, rhythm,
            # object sizes or authored object types are rewritten.
            finish = objects[0]['end_time']
            for index in range(1,len(objects)):
                obj = objects[index]
                if obj['time']-objects[start]['time'] >= 6000 and obj['time'] >= finish:
                    groups.append((start,index)); start = index
                finish = max(finish,obj['end_time'])
            groups.append((start,len(objects)))
            for index,(start,end) in enumerate(groups):
                descriptor = (beatmap,start,end)
                test = beatmap['id'] in withheld if multiple else len(groups)>1 and index%5==len(groups[:5])-1
                (self.testing if test else self.training).append(descriptor)
        if not self.training:
            raise ValueError('Not enough map objects for training')
        self.split = 'withheld maps' if multiple else 'withheld time sections' if self.testing else 'training sections only; no independent test available'

    def choose(self,rng,level=0):
        eligible = self.training[:max(1,min(len(self.training),int(level)+1))]
        return eligible[int(rng.integers(len(eligible)))]

    def evaluation_sections(self,limit=4):
        source = self.testing
        if not source:
            return []
        indices = np.linspace(0,len(source)-1,min(limit,len(source)),dtype=int)
        return [source[index] for index in indices]
