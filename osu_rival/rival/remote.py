"""Train the Rival model on this computer for a Rival app elsewhere on the network (see hub.py).

    python3 -m rival.remote --hub http://HOME-ASSISTANT:8100 --token TOKEN [--processes N] [--environments M]

The trainer attaches to the hub, copies its maps and latest model into a local folder and then runs the normal
worker there, with several environments in several processes. A mirror thread keeps control.json in step with the
hub (Start, Pause and Watch in the app's UI) and uploads what the worker writes: state, live scene and frame,
checkpoints and recorded attempts. By default it uses half of this computer's cores at low priority.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import threading
import time
import urllib.error
import urllib.request

from . import VERSION
from .storage import atomic_bytes, atomic_json, read_json

API = '/remote/v1'
# How often each file may be uploaded (seconds). Checkpoints go up whenever they change.
UPLOADS = {'scene.json': .25, 'frame.png': .25, 'runs.json': 1, 'attempt.json': 0, 'models/latest.npz': 0,
           'models/latest-run.json': 0, 'models/best.npz': 0, 'models/best.json': 0, 'state.json': .5}


class Hub:
    def __init__(self, url, token):
        self.url,self.token,self.session,self.model_generation=url.rstrip('/'),token,'',''

    def request(self, method, path, data=None, content_type='application/json', timeout=5):
        body = data if data is None or isinstance(data, (bytes, bytearray)) else json.dumps(data).encode()
        headers = {'Authorization': f'Bearer {self.token}', 'X-Rival-Session':self.session,'X-Rival-Model':self.model_generation}
        if body is not None:
            headers['Content-Type'] = content_type
        request = urllib.request.Request(self.url + API + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read()
                return json.loads(payload) if response.headers.get('Content-Type', '').startswith('application/json') and content_type != 'raw' else payload
        except urllib.error.HTTPError as error:
            try:
                message = json.loads(error.read()).get('error')
            except ValueError:
                message = None
            raise RuntimeError(message or f'The hub answered {error.code}') from None

    def json(self, path):
        return json.loads(self.request('GET', path, content_type='raw'))


class Mirror(threading.Thread):
    """Keeps control.json in step with the hub and uploads the worker's files as they change."""
    def __init__(self, hub, directory):
        super().__init__(daemon=True)
        self.hub, self.directory = hub, Path(directory)
        self.stop, self.sent, self.last = threading.Event(), {}, {}
        self.error = None
        self.push_lock=threading.Lock()
        self.disconnected=threading.Event()
        self.busy=False;self.acknowledged_pause=None

    def pull_control(self):
        control = self.hub.request('GET', '/control')
        if self.hub.model_generation and control.get('model_generation')!=self.hub.model_generation:
            self.disconnected.set();self.error='The active model changed'
        if self.disconnected.is_set():control={'running':False,'remote_unavailable':True}
        atomic_json(self.directory/'control.json', control)
        pause=control.get('pause_id')
        state=read_json(self.directory/'state.json',{})
        if pause and pause!=self.acknowledged_pause and not self.busy and not self.disconnected.is_set() and not control.get('running') and not control.get('watch') and state.get('status') in (None,'paused'):
            latest=self.directory/'models/latest.npz'
            if latest.exists():
                if not state:
                    from .policy import Policy
                    _,state=Policy.load(latest.read_bytes())
                state.update(status='paused',phase='Ready when you are',pause_id=pause)
                atomic_json(self.directory/'state.json',state)
                self.push(force=True);self.acknowledged_pause=pause
        return control

    def push(self, force=False):
        with self.push_lock:self._push(force)

    def _push(self, force=False):
        now = time.monotonic()
        for name, every in UPLOADS.items():
            path = self.directory/name
            try:
                stamp = path.stat().st_mtime_ns
            except FileNotFoundError:
                continue
            if self.sent.get(name) == stamp or (not force and now - self.last.get(name, 0) < every):
                continue
            data = path.read_bytes()
            if name=='state.json':
                state=json.loads(data)
                if force and state.get('status')=='paused':
                    state['pause_id']=read_json(self.directory/'control.json',{}).get('pause_id')
                    data=json.dumps(state).encode()
            content = 'image/png' if name.endswith('.png') else 'application/octet-stream' if name.endswith('.npz') else 'application/json'
            self.hub.request('PUT', f'/files/{name}', data, content_type=content)
            self.sent[name], self.last[name] = stamp, now

    def run(self):
        while not self.stop.wait(.2):
            try:
                if time.monotonic() - self.last.get('control', 0) > 1:
                    self.pull_control()
                    self.last['control'] = time.monotonic()
                self.push()
                self.error = None
            except (OSError, RuntimeError, ValueError) as error:
                self.disconnected.set()
                self.error = str(error)
                atomic_json(self.directory/'control.json',{'running':False,'remote_unavailable':True})
                self.stop.wait(2)


def sync(hub, directory, clear_state=True):
    """Copy the hub's maps and model. Maps that are no longer on the hub are removed, so the training and test
    split is the same on both machines."""
    hello = hub.request('GET', '/hello')
    if hello['version'] != VERSION:
        raise SystemExit(f'This trainer is version {VERSION} but the app runs {hello["version"]}. Download the trainer again.')
    hub.model_generation=hello['model_generation']
    maps = Path(directory)/'maps'
    maps.mkdir(parents=True, exist_ok=True)
    wanted = {entry['id']: entry['sha256'] for entry in hello['maps']}
    for path in maps.glob('*.json'):
        if path.stem not in wanted:
            path.unlink()
    fetched = 0
    for map_id, digest in wanted.items():
        path = maps/f'{map_id}.json'
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == digest:
            continue
        atomic_bytes(path, hub.request('GET', f'/maps/{map_id}.json', content_type='raw'))
        fetched += 1
    models = Path(directory)/'models'
    models.mkdir(exist_ok=True)
    for name in ['models/latest.npz', 'models/latest-run.json', 'models/initial.npz','models/best.npz', 'models/best.json']:
        try:
            atomic_bytes(Path(directory)/name, hub.request('GET', f'/files/{name}', content_type='raw'))
        except RuntimeError:
            (Path(directory)/name).unlink(missing_ok=True)   # not saved on the hub yet
    if clear_state:
        for name in ['state.json', 'scene.json', 'frame.png', 'attempt.json','runs.json']:
            (Path(directory)/name).unlink(missing_ok=True)
    return hello, fetched


def main():
    cores = os.cpu_count() or 2
    parser = argparse.ArgumentParser(description='Train an osu! Rival model on this computer.')
    parser.add_argument('--hub', required=True, help='The Rival app hub, for example http://homeassistant.local:8100')
    parser.add_argument('--token', default='', help='The hub token shown in the Rival app')
    parser.add_argument('--token-file', help='Read the hub token from a private file')
    parser.add_argument('--processes', type=int, default=max(1, cores // 2), help=f'CPU processes to use (default: half of {cores})')
    parser.add_argument('--environments', type=int, default=0, help='Environments played at once (default: two per process)')
    parser.add_argument('--data', default=str(Path.home()/'.local/share/osu-rival-trainer'), help='Local working folder')
    parser.add_argument('--name', default=platform.node() or 'another computer', help='Name shown in the Rival app')
    args = parser.parse_args()
    processes = max(1, min(args.processes, cores))
    environments = args.environments or processes * 2
    directory = Path(args.data)
    directory.mkdir(parents=True, exist_ok=True)
    try:
        os.nice(10)   # stay out of the way of games and other work on this computer
    except OSError:
        pass
    token=Path(args.token_file).read_text().strip() if args.token_file else args.token
    if len(token)<24:parser.error('Supply --token or --token-file with the hub token')
    if not 1<=environments<=64:parser.error('Use 1 to 64 environments')
    processes=min(processes,environments)
    hub = Hub(args.hub, token)
    print(f'osu! Rival trainer {VERSION}: {environments} environments on {processes} of {cores} cores, at low priority.', flush=True)
    stop = threading.Event()
    def our_signals():
        # The worker installs its own handlers while it runs (Ctrl+C then stops training cleanly); put ours back after.
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
    our_signals()
    info = {'name': args.name, 'cores': cores, 'processes': processes, 'environments': environments, 'version': VERSION}
    from .worker import Worker
    while not stop.is_set():
        try:
            attached = hub.request('POST', '/attach', info)
        except (OSError, RuntimeError) as error:
            print(f'Cannot attach: {error}. Retrying in 10 s.', flush=True)
            stop.wait(10); continue
        hub.session = info['session'] = attached['session']
        try:hello,fetched=sync(hub,directory)
        except (OSError,RuntimeError,ValueError) as error:
            print(f'Cannot sync trainer: {error}. Retrying.',flush=True)
            stop.wait(5);continue
        print(f'Attached as "{args.name}". {len(hello["maps"])} maps ({fetched} downloaded).', flush=True)
        options = {'seed': attached['seed'], 'cpu_budget_percent': 100, 'memory_limit_mb': 2048 * max(1, processes // 2),
                   'min_available_memory_mb': 512, 'max_temperature_c': 95, 'parallel_envs': environments, 'processes': processes}
        atomic_json(directory/'worker-options.json', options)
        mirror = Mirror(hub, directory)
        atomic_json(directory/'control.json', attached['control'])
        mirror.start()
        try:
            while not stop.is_set():
                if mirror.disconnected.is_set():break
                control = read_json(directory/'control.json', {})
                watch = control.get('watch')
                if control.get('running'):
                    print('Training. Pause it in the Rival app, or press Ctrl+C here.', flush=True)
                    with mirror.push_lock:sync(hub,directory,clear_state=False)
                    mirror.pull_control()
                    mirror.busy=True
                    worker = Worker(directory)
                    worker.run()   # returns when the app pauses training, or on Ctrl+C
                    mirror.busy=False
                    our_signals()
                    if worker.stop:
                        stop.set()
                    mirror.push(force=True)
                    print('Stopped; the latest model is saved in the app.' if stop.is_set() else 'Paused; the latest model is saved in the app.', flush=True)
                elif watch and watch.get('id') != read_json(directory/'attempt.json', {}).get('id'):
                    with mirror.push_lock:sync(hub,directory,clear_state=False)
                    mirror.pull_control()
                    mirror.busy=True
                    worker = Worker(directory, once=True)
                    worker.run()
                    mirror.busy=False
                    mirror.busy=False
                    our_signals()
                    if worker.stop:stop.set()
                    mirror.push(force=True)
                else:
                    stop.wait(1)
                if mirror.error:
                    print(f'Connection problem: {mirror.error}. Reconnecting.', flush=True)
                    break
        except (OSError,RuntimeError,ValueError) as error:
            print(f'Trainer connection failed: {error}. Reconnecting.',flush=True)
            stop.wait(2)
        finally:
            mirror.stop.set(); mirror.join(timeout=5)
            try:
                mirror.push(force=True)
                hub.request('POST', '/detach', {'session': hub.session})
            except (OSError, RuntimeError):
                pass
    print('Detached.', flush=True)


if __name__ == '__main__':
    main()
