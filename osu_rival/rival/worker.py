"""One interruptible learning process, with CPU and host resource guards."""
import argparse
import copy
import hashlib
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
from .parallel import Trainer
from .storage import atomic_bytes, atomic_json, read_json
from .vision import view


class StopWorker(Exception):
    pass


def resources(children=()):
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
    for pid in children:
        try:
            lines=Path(f'/proc/{pid}/status').read_text().splitlines()
            result['worker_memory_mb'] += next(int(line.split()[1])/1024 for line in lines if line.startswith('VmRSS:'))
        except (OSError,StopIteration,TypeError):pass
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
                      'episodes': 0, 'completed_maps':0, 'stage': 0, 'history': [], 'baselines': {},
                      'seed': self.seed, 'last_error': None, 'training_source': 'Random initialization and rewards',
                      'training_format': 'real-beatmap-v1', 'training_strategy':'full-maps-v1',
                      'server_play': {'available': False, 'reason': 'Practice only. Native ruleset and multiplayer integration are not available in this release.'}}
        previous_state=read_json(self.directory/'state.json',{})
        if 'map_sync' in previous_state:
            self.state['map_sync']=previous_state['map_sync']
        latest = self.directory/'models/latest.npz'
        if latest.exists():
            original = latest.read_bytes()
            self.policy,metadata = Policy.load(original)
            if metadata.get('training_format') != 'real-beatmap-v1':
                raise ValueError('This checkpoint used generated practice. Import a real-beatmap checkpoint or start with a new data directory.')
            if metadata.get('training_strategy')!='full-maps-v1':
                backup=self.directory/'models/before-full-maps.npz'
                if not backup.exists():atomic_bytes(backup,original)
            if metadata.get('migrated_from_observation'):
                backup=self.directory/'models/before-padding.npz'
                if not backup.exists():atomic_bytes(backup,original)
                atomic_json(self.directory/'models/evaluations-before-padding.json',{'history':metadata.get('history',[]),'baselines':metadata.get('baselines',{})})
                metadata.update(history=[],baselines={})
                self.state['vision_migration']='Retained trained weights and optimizer; added visible margins'
            for key in ['updates', 'steps', 'episodes', 'completed_maps', 'stage', 'history', 'baselines', 'seed']:
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
        original_initial=initial.read_bytes()
        self.initial,initial_metadata=Policy.load(original_initial)
        if initial_metadata.get('training_format')!='real-beatmap-v1':
            raise ValueError('The initial comparison model belongs to the previous practice format')
        if initial_metadata.get('migrated_from_observation'):
            backup=self.directory/'models/initial-before-padding.npz'
            if not backup.exists():atomic_bytes(backup,original_initial)
            self.initial.save(initial,initial_metadata)
        self.state['parameters'] = self.policy.parameter_count
        self.state['observation_view']=view()
        self.library = MapLibrary(self.directory/'maps')
        self.state.update({'map_count':len(self.library.maps),'training_maps':len(self.library.training),
                           'test_sections':len(self.library.testing),'test_split':self.library.split,
                           'training_source':'Real beatmaps, pixels and rewards; no player replays'})
        if not self.library.testing:
            self.state.update(history=[],baselines={})
        self.env = Environment(library=self.library)
        self.parallel_saved=None
        run_path=self.directory/'models/latest-run.json'
        if latest.exists() and run_path.exists() and run_path.stat().st_size<=32*1024*1024:
            saved=read_json(run_path,{})
            if saved.get('checkpoint_sha256')==hashlib.sha256(original).hexdigest():
                self.parallel_saved=saved.get('parallel')
                try:self.env.restore_run(saved['run'])
                except (ValueError,KeyError,TypeError):
                    self.env=Environment(library=self.library)
        self.guard_state = resources()
        # Parallel training (a computer with spare cores): several environments in several processes. The Pi keeps
        # the original single environment in one throttled thread.
        self.parallel_envs = max(1, min(64, int(self.options.get('parallel_envs', 1))))
        self.processes = max(1, min(self.parallel_envs, int(self.options.get('processes', 1))))
        self.trainer = None
        self.trail = []

    def control(self):
        return read_json(self.directory/'control.json', {})

    def publish(self, force=False):
        now = time.monotonic()
        if not force and now-self.last_publish < .35:
            return
        self.last_publish = now
        self.state.update({'updated_at': time.time(), 'resources': self.guard_state,
                           'stage_name':self.env.beatmap['title'], 'current_map':self.env.map_info(),
                           'map_progress':self.env.progress(),'pid':os.getpid(),
                           'worker_budget':{key:self.options.get(key) for key in ['cpu_budget_percent','memory_limit_mb']}})
        atomic_json(self.directory/'state.json', self.state)

    def checkpoint(self):
        checkpoint=self.policy.serialize(self.metadata())
        atomic_bytes(self.directory/'models/latest.npz',checkpoint)
        parallel=self.trainer.snapshot() if self.trainer is not None else self.parallel_saved
        if self.trainer is None and parallel:
            # A Pi-only run advances the primary while the PC's other runs wait.
            # Keep their positions for the next workstation session.
            parallel=copy.deepcopy(parallel)
            for shard in parallel.get('shards',[]):
                if 0 in shard.get('indices',[]):
                    shard['runs'][shard['indices'].index(0)]=self.env.save_run()
        self.parallel_saved=parallel
        atomic_json(self.directory/'models/latest-run.json',{'checkpoint_sha256':hashlib.sha256(checkpoint).hexdigest(),'run':self.env.save_run(),'parallel':parallel})

    def metadata(self):
        return {key: self.state[key] for key in ['updates', 'steps', 'episodes', 'completed_maps', 'stage', 'history', 'baselines', 'seed']} | {'rng':self.rng.bit_generator.state,'training_format':'real-beatmap-v1','training_strategy':'full-maps-v1'}

    def tick(self):
        if self.stop or self.control().get('remote_unavailable') or (self.once and not self.control().get('watch')) or (not self.once and not self.control().get('running')):
            raise StopWorker()
        now = time.monotonic()
        if now-self.last_guard > 1:
            self.last_guard = now
            children=[process.pid for process,_ in self.trainer.workers] if self.trainer else []
            self.guard_state = resources(children)
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
                    if self.stop or self.control().get('remote_unavailable') or (self.once and not self.control().get('watch')) or (not self.once and not self.control().get('running')):
                        raise StopWorker()
                    time.sleep(.5)
                    info = resources(children)
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
            if self.stop or self.control().get('remote_unavailable') or (self.once and not self.control().get('watch')) or (not self.once and not self.control().get('running')):
                raise StopWorker()
            time.sleep(min(delay, .05))
            delay = (time.process_time()-self.cpu_start)/fraction - (time.monotonic()-self.wall_start)
        self.publish()

    def frame(self, env, index=0):
        self.tick()
        # The cursor's path since the last snapshot lets the live view follow it instead of guessing in between.
        self.trail.append([round(env.time, 1), round(env.cursor[0], 1), round(env.cursor[1], 1), env.keys])
        if len(self.trail) > 600:
            del self.trail[:-600]
        if time.monotonic() - getattr(self, 'last_frame', 0) < .25:
            return
        self.last_frame = time.monotonic()
        stream = io.BytesIO()
        Image.fromarray(env.frames[-1]).save(stream, format='PNG')
        atomic_bytes(self.directory/'frame.png', stream.getvalue())
        trail = [point for point in self.trail if point[0] <= env.time]
        self.trail = []
        atomic_json(self.directory/'scene.json', env.scene(visible_only=True) | {'trail': trail})

    def parallel_views(self,runs):
        atomic_json(self.directory/'runs.json',{'updated_at':time.time(),'runs':runs})

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
            env = Environment(seed=seed,beatmap=self.env.beatmap)
        rng = np.random.default_rng(seed+900000)
        start_scene = env.scene()
        frames, events = [], []
        observation = env.observation()
        # Record the complete map, including the final hit window.
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
            if self.processes == 1 and hasattr(os, 'sched_getaffinity'):
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
                interrupt = lambda: self.stop or not self.control().get('running')
                started=time.monotonic()
                if self.parallel_envs > 1:
                    if self.trainer is None:
                        self.state['phase'] = f'Starting {self.parallel_envs} environments on {self.processes} cores'
                        self.publish(force=True)
                        self.trainer = Trainer(self.policy, self.library, self.directory/'maps', self.parallel_envs,
                                               self.processes, self.seed + self.state['updates'], first=self.env)
                        if self.parallel_saved:
                            try:self.trainer.restore(self.parallel_saved)
                            except (ValueError,KeyError,TypeError):pass
                        self.state['parallel'] = {'environments': self.parallel_envs, 'processes': self.processes}
                        self.state['phase'] = 'Learning from rewards'
                    result = self.trainer.update(self.rng, steps=128, progress=self.frame, interrupt=interrupt,views=self.parallel_views)
                else:
                    result = update(self.policy, self.env, self.rng, progress=self.frame, interrupt=interrupt)
                if result is None:
                    break
                self.state['updates'] += 1
                self.state['steps'] += result['steps']
                self.state['episodes'] += len(result['episodes'])
                self.state['completed_maps'] += len(result['episodes'])
                self.state['training'] = {key: value for key, value in result.items() if key != 'episodes'}
                self.state['training']['steps_per_second']=round(result['steps']/max(.001,time.monotonic()-started),1)
                self.checkpoint()
                if self.state['updates']%10 == 0 or self.state['updates']==1:
                    sections = self.library.evaluation_sections()
                    if sections:
                        self.state['phase'] = 'Checking withheld real beatmap sections'
                        self.publish(force=True)
                        signature = 'full-maps-v1:observation-v2:'+','.join(f"{beatmap['id']}:{start}:{end}" for beatmap,start,end in sections)
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
            if self.trainer is not None:
                self.parallel_views(self.trainer.scenes())
                self.parallel_saved=self.trainer.snapshot()
                self.trainer.close()
                self.trainer = None
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
