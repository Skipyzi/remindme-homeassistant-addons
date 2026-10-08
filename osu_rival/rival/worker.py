"""One interruptible learning process, with CPU and host resource guards."""
import argparse
import io
import json
import os
from pathlib import Path
import signal
import time
import traceback

import numpy as np
from PIL import Image

from .environment import Environment
from .beatmaps import MapLibrary
from .policy import Policy, evaluate, update
from .storage import atomic_bytes, atomic_json, read_json


class StopWorker(Exception):
    pass


def resources():
    result = {'available_memory_mb': None, 'temperature_c': None, 'worker_memory_mb': None}
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'):
                result['available_memory_mb'] = round(int(line.split()[1]) / 1024)
        for line in Path('/proc/self/status').read_text().splitlines():
            if line.startswith('VmRSS:'):
                result['worker_memory_mb'] = round(int(line.split()[1]) / 1024, 1)
    except OSError:
        pass
    try:
        result['temperature_c'] = round(int(Path('/sys/class/thermal/thermal_zone0/temp').read_text()) / 1000, 1)
    except (OSError, ValueError):
        pass
    return result


class Worker:
    def __init__(self, directory, once=False):
        self.directory = Path(directory)
        self.once = once
        self.options = read_json(self.directory/'worker-options.json', {})
        self.seed = int(self.options.get('seed', 42))
        self.stop = False
        self.last_publish = self.last_guard = 0.0
        self.cpu_start, self.wall_start = time.process_time(), time.monotonic()
        self.completed_watch = ''
        self.state = {'status': 'starting', 'phase': 'Loading the learner', 'updates': 0, 'steps': 0,
                      'episodes': 0, 'stage': 0, 'history': [], 'baselines': {}, 'promotions': 0,
                      'seed': self.seed, 'last_error': None, 'training_source': 'Random initialization and rewards',
                      'training_format': 'real-beatmap-v1', 'recent_episodes': [],
                      'server_play': {'available': False, 'reason': 'Practice only. Native ruleset and multiplayer integration are not available in this release.'}}
        previous_state=read_json(self.directory/'state.json',{})
        if 'map_sync' in previous_state:
            self.state['map_sync']=previous_state['map_sync']
        latest = self.directory/'models/latest.npz'
        if latest.exists():
            self.policy, metadata = Policy.load(latest.read_bytes())
            if metadata.get('training_format') != 'real-beatmap-v1':
                raise ValueError('This checkpoint used generated practice. Import a real-beatmap checkpoint or start with a new data directory.')
            for key in ['updates', 'steps', 'episodes', 'stage', 'history', 'baselines', 'seed']:
                if key in metadata:
                    self.state[key] = metadata[key]
            self.seed = int(self.state['seed'])
            self.state['history'] = self.state['history'][-300:]
            self.state['stage'] = max(int(self.state['stage']),0)
            self.rng = np.random.default_rng(self.seed)
            if 'rng' in metadata:
                self.rng.bit_generator.state = metadata['rng']
        else:
            self.policy = Policy(self.seed)
            self.rng = np.random.default_rng(self.seed)
        initial = self.directory/'models/initial.npz'
        if not initial.exists():
            Policy(self.seed).save(initial, {'seed': self.seed, 'updates': 0, 'stage': 0, 'training_format': 'real-beatmap-v1'})
        self.initial, initial_metadata = Policy.load(initial.read_bytes())
        if initial_metadata.get('training_format')!='real-beatmap-v1':
            raise ValueError('The initial comparison model belongs to the previous practice format')
        self.state['parameters'] = self.policy.parameter_count
        self.library = MapLibrary(self.directory/'maps')
        self.state.update({'map_count':len(self.library.maps),'training_sections':len(self.library.training),
                           'test_sections':len(self.library.testing),'test_split':self.library.split,
                           'training_source':'Real beatmaps, pixels and rewards; no player replays'})
        self.state['stage'] = min(self.state['stage'],len(self.library.training)-1)
        self.env = Environment(seed=int(self.rng.integers(0,2**31)),library=self.library,level=self.state['stage'])
        self.promotion_streak = 0
        self.guard_state = resources()

    def control(self):
        return read_json(self.directory/'control.json', {})

    def publish(self, force=False):
        now = time.monotonic()
        if not force and now-self.last_publish < .35:
            return
        self.last_publish = now
        self.state.update({'updated_at': time.time(), 'resources': self.guard_state,
                           'stage_name':self.env.beatmap['title'], 'current_map':self.env.scene()['map'],
                           'eligible_sections':min(len(self.library.training),self.state['stage']+1),'pid':os.getpid()})
        atomic_json(self.directory/'state.json', self.state)

    def checkpoint(self):
        self.policy.save(self.directory/'models/latest.npz', self.metadata())

    def metadata(self):
        return {key: self.state[key] for key in ['updates', 'steps', 'episodes', 'stage', 'history', 'baselines', 'seed']} | {'rng':self.rng.bit_generator.state,'training_format':'real-beatmap-v1'}

    def tick(self):
        if self.stop or (not self.once and not self.control().get('running')):
            raise StopWorker()
        now = time.monotonic()
        if now-self.last_guard > 1:
            self.last_guard = now
            self.guard_state = resources()
            reason = None
            if self.guard_state['worker_memory_mb'] and self.guard_state['worker_memory_mb'] > self.options.get('memory_limit_mb', 512):
                raise MemoryError('Worker exceeded its memory budget. Training is paused; the last checkpoint is retained.')
            if self.guard_state['available_memory_mb'] is not None and self.guard_state['available_memory_mb'] < self.options.get('min_available_memory_mb', 768):
                reason = 'Waiting for more available memory'
            if self.guard_state['temperature_c'] is not None and self.guard_state['temperature_c'] >= self.options.get('max_temperature_c', 75):
                reason = 'Waiting for the Pi to cool down'
            if reason:
                self.state.update({'status': 'resource_pause', 'phase': reason})
                self.publish(force=True)
                while reason:
                    if self.stop or (not self.once and not self.control().get('running')):
                        raise StopWorker()
                    time.sleep(.5)
                    info = resources()
                    hot = info['temperature_c'] is not None and info['temperature_c'] >= self.options.get('max_temperature_c', 75)-3
                    low = info['available_memory_mb'] is not None and info['available_memory_mb'] < self.options.get('min_available_memory_mb', 768)+64
                    reason = 'Waiting for the Pi to cool down' if hot else 'Waiting for more available memory' if low else None
                    self.guard_state = info
                    self.state['phase'] = reason or 'Resuming training'
                    self.publish()
                self.cpu_start, self.wall_start = time.process_time(), time.monotonic()
                self.state['status'] = 'training' if not self.once else 'watching'
        fraction = self.options.get('cpu_budget_percent', 25) / 100
        delay = (time.process_time()-self.cpu_start)/fraction - (time.monotonic()-self.wall_start)
        # Short sleeps keep pause and shutdown responsive. This is a duty-cycle
        # budget for one thread, not a claim of a hard container CPU quota.
        while delay > .002:
            if self.stop or (not self.once and not self.control().get('running')):
                raise StopWorker()
            time.sleep(min(delay, .05))
            delay = (time.process_time()-self.cpu_start)/fraction - (time.monotonic()-self.wall_start)
        self.publish()

    def frame(self, env, index=0):
        self.tick()
        if time.monotonic() - getattr(self, 'last_frame', 0) < .25:
            return
        self.last_frame = time.monotonic()
        stream = io.BytesIO()
        Image.fromarray(env.frames[-1]).save(stream, format='PNG')
        atomic_bytes(self.directory/'frame.png', stream.getvalue())
        atomic_json(self.directory/'scene.json', env.scene())

    def watch(self, request):
        self.state.update({'status': 'watching', 'phase': 'Recording one attempt'})
        self.publish(force=True)
        seed = int(request.get('seed', 7123))
        map_id = request.get('map_id')
        if map_id:
            beatmap = read_json(self.directory/'maps'/f'{map_id}.json')
            if beatmap is None:
                raise ValueError('The selected real beatmap is missing')
            beatmap['id'] = map_id
            env = Environment(seed=seed,beatmap=beatmap)
        else:
            env = Environment(seed=seed,library=self.library,level=self.state['stage'])
        rng = np.random.default_rng(seed+900000)
        start_scene = env.scene()
        frames, events = [], []
        observation = env.observation()
        # Record the full real-map section, including the final hit window.
        while env.time < env.end_time:
            self.tick()
            latent, key, _, _ = self.policy.sample(observation, rng)
            action_time = env.time
            observation, _, _ = env.step((latent, key))
            frames.append([round(action_time, 2), round(env.cursor[0], 2), round(env.cursor[1], 2), key])
            if env.last_judgment and (not events or events[-1] != env.last_judgment):
                events.append(dict(env.last_judgment))
            self.frame(env)
        replay = {'id': request['id'], 'seed': seed, 'stage':self.state['stage'],'stage_name':env.beatmap['title'],
                  'updates': self.state['updates'], 'map_id': map_id, 'created_at': time.time(),
                  'scene': start_scene, 'frames':frames,'events':env.events, 'summary': env.summary(),
                  'title':env.beatmap['title']}
        atomic_json(self.directory/'attempt.json', replay)
        self.completed_watch = request['id']
        self.state['last_attempt'] = {'id': replay['id'], 'summary': replay['summary'], 'updates': replay['updates']}

    def run(self):
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, 'stop', True))
        signal.signal(signal.SIGINT, lambda *_: setattr(self, 'stop', True))
        try:
            os.nice(10)
            if hasattr(os, 'sched_getaffinity'):
                available = sorted(os.sched_getaffinity(0))
                if available:
                    os.sched_setaffinity(0, {available[-1]})
        except OSError:
            pass
        try:
            if self.once:
                request = self.control().get('watch')
                if request:
                    self.watch(request)
                return
            while not self.stop and self.control().get('running'):
                request = self.control().get('watch')
                if request and request['id'] != self.completed_watch:
                    existing = read_json(self.directory/'attempt.json', {})
                    if request['id'] != existing.get('id'):
                        self.watch(request)
                self.state.update({'status': 'training', 'phase': 'Learning from rewards'})
                result = update(self.policy, self.env, self.rng, progress=self.frame,
                                interrupt=lambda: self.stop or not self.control().get('running'))
                if result is None:
                    break
                self.state['updates'] += 1
                self.state['steps'] += result['steps']
                self.state['episodes'] += len(result['episodes'])
                self.state['training'] = {key: value for key, value in result.items() if key != 'episodes'}
                self.checkpoint()
                self.state['recent_episodes'] = (self.state['recent_episodes']+result['episodes'])[-20:]
                recent = self.state['recent_episodes']
                if len(recent)>=10 and np.mean([item['accuracy'] for item in recent])>=.65 and self.state['stage']<len(self.library.training)-1:
                    self.state['stage'] += 1
                    self.env.level = self.state['stage']
                    self.state['promotions'] += 1
                    self.state['recent_episodes'] = []
                if self.state['updates']%10 == 0 or self.state['updates']==1:
                    sections = self.library.evaluation_sections()
                    if sections:
                        self.state['phase'] = 'Checking withheld real beatmap sections'
                        self.publish(force=True)
                        signature = ','.join(f"{beatmap['id']}:{start}:{end}" for beatmap,start,end in sections)
                        if signature not in self.state['baselines']:
                            self.state['baselines'][signature] = evaluate(self.initial,sections,tick=self.tick)
                        evaluation = evaluate(self.policy,sections,tick=self.tick)
                        self.state['evaluation'] = evaluation
                        point = {'update':self.state['updates'],'stage':self.state['stage'],
                                 'hit_rate':evaluation['hit_rate'],'accuracy':evaluation['accuracy'],
                                 'baseline':self.state['baselines'][signature]['accuracy']}
                        self.state['history'] = (self.state['history']+[point])[-300:]
                        best = read_json(self.directory/'models/best.json',{})
                        if signature != best.get('signature') or evaluation['accuracy']>best.get('accuracy',-1):
                            self.policy.save(self.directory/'models/best.npz',self.metadata())
                            atomic_json(self.directory/'models/best.json',point|{'signature':signature})
                    self.checkpoint()
                self.publish(force=True)

        except StopWorker:
            pass
        except Exception as error:
            self.state.update({'status': 'error', 'last_error': str(error), 'phase': 'Training stopped'})
            self.publish(force=True)
            traceback.print_exc()
            return
        finally:
            if self.state['status'] != 'error':
                self.checkpoint()
                self.state.update({'status': 'paused', 'phase': 'Ready when you are'})
                self.publish(force=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', required=True)
    parser.add_argument('--watch', action='store_true')
    args = parser.parse_args()
    try:
        Worker(args.data, once=args.watch).run()
    except Exception as error:
        atomic_json(Path(args.data)/'state.json', {'status': 'error', 'last_error': str(error), 'phase': 'Unable to load the learner'})
        traceback.print_exc()


if __name__ == '__main__':
    main()
