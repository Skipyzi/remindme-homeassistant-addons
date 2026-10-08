"""Ingress web UI and control API. Gameplay training runs in one subprocess."""
import argparse
import hashlib
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import mimetypes
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit
import uuid
import zipfile

from . import VERSION
from .beatmaps import parse_beatmap
from .policy import Policy, SHAPES
from .storage import atomic_bytes, atomic_json, read_json
from .vision import view

DEFAULTS = {'train_on_start': False, 'cpu_budget_percent': 25, 'memory_limit_mb': 512,
            'min_available_memory_mb':768,'max_temperature_c':75,'seed':42,
            'beatmap_server_url':'http://local-osu-server:8087'}
LIMITS = {'cpu_budget_percent': (5, 100), 'memory_limit_mb': (192, 2048),
          'min_available_memory_mb': (256, 4096), 'max_temperature_c': (55, 85), 'seed': (0, 2147483647)}


class Controller:
    def __init__(self, directory, options=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        for folder in ['models', 'maps']:
            (self.directory/folder).mkdir(exist_ok=True)
        # A saved frame from an older observation layout cannot be displayed
        # using the current mapping. The worker replaces it on its next frame.
        saved_scene=read_json(self.directory/'scene.json',{})
        if saved_scene and saved_scene.get('observation_view')!=view():
            (self.directory/'scene.json').unlink(missing_ok=True)
            (self.directory/'frame.png').unlink(missing_ok=True)
        self.options = {**DEFAULTS, **(options or {})}
        for key, (minimum, maximum) in LIMITS.items():
            value = self.options[key]
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f'{key} must be an integer between {minimum} and {maximum}')
        parsed = urlsplit(self.options['beatmap_server_url'])
        if parsed.scheme not in ('http','https') or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError('beatmap_server_url must be an HTTP URL without credentials')
        self.map_catalogue = {}
        self.sync_thread = None
        self.sync_cancel = threading.Event()
        if type(self.options['train_on_start']) is not bool:
            raise ValueError('train_on_start must be true or false')
        atomic_json(self.directory/'worker-options.json', self.options)
        self.lock = threading.RLock()
        self.process = None
        self.log_handle = None
        self.monitor_stop = threading.Event()
        atomic_json(self.directory/'control.json', {'running': False})
        self.monitor = threading.Thread(target=self._monitor, daemon=True)
        self.monitor.start()
        if self.options['train_on_start']:
            self.start()

    def _spawn(self, watch=False):
        if self.process and self.process.poll() is None:
            return
        if self.log_handle:
            self.log_handle.close()
        log = self.directory/'worker.log'
        if log.exists() and log.stat().st_size > 2*1024*1024:
            log.replace(self.directory/'worker-previous.log')
        self.log_handle = log.open('ab', buffering=0)
        command = [sys.executable, '-m', 'rival.worker', '--data', str(self.directory)]
        if watch:
            command.append('--watch')
        env = {**os.environ, 'OPENBLAS_NUM_THREADS': '1', 'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1'}
        self.process = subprocess.Popen(command, stdout=self.log_handle, stderr=self.log_handle, env=env, start_new_session=True)

    def _monitor(self):
        while not self.monitor_stop.wait(.5):
            with self.lock:
                if not self.process or self.process.poll() is not None:
                    continue
                try:
                    status = Path(f'/proc/{self.process.pid}/status').read_text()
                    rss = next(int(line.split()[1])/1024 for line in status.splitlines() if line.startswith('VmRSS:'))
                    if rss > self.options['memory_limit_mb']:
                        control = read_json(self.directory/'control.json', {})
                        control['running'] = False
                        atomic_json(self.directory/'control.json', control)
                        self.process.terminate()
                        state = read_json(self.directory/'state.json', {})
                        state.update({'status': 'error', 'last_error': 'Memory budget exceeded. Reduce the training workload or increase the app memory budget.', 'phase': 'Training stopped'})
                        atomic_json(self.directory/'state.json', state)
                except (OSError, StopIteration):
                    pass

    def status(self):
        with self.lock:
            state = read_json(self.directory/'state.json', {})
            running = bool(self.process and self.process.poll() is None)
            syncing = self.sync_thread is not None and self.sync_thread.is_alive()
            if not running and not syncing and state.get('status') not in ['error']:
                state.update({'status': 'paused', 'phase': 'Ready when you are'})
            if not running and state.get('resources'):
                state['resources']['worker_memory_mb'] = None
            if running and state.get('status') in [None, 'paused']:
                state.update({'status': 'starting', 'phase': 'Loading the learner'})
            state.update({'version':VERSION,'observation_view':view(),'worker_running': running, 'options': self.options,
                          'checkpoints': self.checkpoints(),
                          'maps': self.maps(), 'parameters': sum(math.prod(shape) for shape in SHAPES.values()),
                          'server_play': {'available': False, 'reason': 'Practice only. Native ruleset and multiplayer integration are not available in this release.'}})
            return state

    def start(self):
        with self.lock:
            if self.process and self.process.poll() is None:
                control = read_json(self.directory/'control.json', {})
                if not control.get('running'):
                    raise ValueError('An attempt is being recorded. Wait for it to finish before starting training.')
                return self.status()
            if not self.maps():
                return self.sync_maps(start_after=True)
            control = read_json(self.directory/'control.json', {})
            control['running'] = True
            atomic_json(self.directory/'control.json', control)
            state = read_json(self.directory/'state.json', {})
            state.update({'status': 'starting', 'phase': 'Loading the learner', 'last_error': None})
            atomic_json(self.directory/'state.json', state)
            self._spawn()
            return self.status()

    def pause(self):
        with self.lock:
            control = read_json(self.directory/'control.json', {})
            self.sync_cancel.set()
            control['running'] = False
            atomic_json(self.directory/'control.json', control)
            if self.process and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
                    state = read_json(self.directory/'state.json', {})
                    state.update({'status': 'error', 'phase': 'Training stopped', 'last_error': 'Worker did not stop in time. The last completed checkpoint is retained.'})
                    atomic_json(self.directory/'state.json', state)
            return self.status()

    def checkpoints(self):
        return [{'name': path.name, 'bytes': path.stat().st_size, 'modified_at': path.stat().st_mtime}
                for path in sorted((self.directory/'models').glob('*.npz'))]

    def maps(self):
        result = []
        for path in sorted((self.directory/'maps').glob('*.json')):
            modified = path.stat().st_mtime_ns
            cached = self.map_catalogue.get(path.stem)
            if not cached or cached[0]!=modified:
                data = read_json(path)
                if not data or data.get('format')!='real-beatmap-v1':
                    continue
                entry = {'id':path.stem,**{key:data[key] for key in ['title','artist','difficulty','cs','od','ar','counts','beatmap_id']},'objects':len(data['objects'])}
                self.map_catalogue[path.stem] = (modified,entry)
            result.append(self.map_catalogue[path.stem][1])
        return result

    def sync_maps(self, start_after=False):
        with self.lock:
            if self.process and self.process.poll() is None:
                raise ValueError('Pause training before syncing more maps')
            if self.sync_thread and self.sync_thread.is_alive():
                return self.status()
            self.sync_cancel.clear()
            def synchronize():
                import urllib.request
                import urllib.error
                state = read_json(self.directory/'state.json',{})
                state.update(status='syncing',phase='Copying real beatmaps from the server cache',last_error=None)
                atomic_json(self.directory/'state.json',state)
                imported,skipped,errors = 0,0,[]
                base = self.options['beatmap_server_url'].rstrip('/')+'/api/home/rival/maps'
                try:
                    with urllib.request.urlopen(base+'?limit=100',timeout=10) as response:
                        body = response.read(256*1024+1)
                        if len(body)>256*1024:
                            raise ValueError('Server map catalogue is too large')
                        catalogue = json.loads(body)
                    if catalogue.get('source')!='local-raw-cache' or catalogue.get('upstream_requests')!=0:
                        raise ValueError('Expected a cache-only beatmap source')
                    for entry in catalogue['maps'][:100]:
                        if self.sync_cancel.is_set():
                            break
                        beatmap_id = entry.get('id')
                        if type(beatmap_id) is not int or beatmap_id<=0:
                            continue
                        if any(item['beatmap_id']==beatmap_id for item in self.maps()):
                            skipped += 1; continue
                        try:
                            with urllib.request.urlopen(f'{base}/{beatmap_id}/raw',timeout=10) as response:
                                content = response.read(2*1024*1024+1)
                            if len(content)>2*1024*1024:
                                raise ValueError('Map file is too large')
                            self.import_map(content.decode('utf-8-sig'))
                            imported += 1
                        except (OSError,UnicodeError,ValueError) as error:
                            errors.append(f'{beatmap_id}: {str(error)[:100]}')
                        state.update(phase=f'Copied {imported} real beatmaps; {skipped} already saved')
                        atomic_json(self.directory/'state.json',state)
                    if not self.maps():
                        raise ValueError('No real maps are cached. Open a map in the server Finder or import its .osu file here.')
                    state.update(status='paused',phase='Real beatmaps ready',map_sync={'imported':imported,'already_saved':skipped,
                                 'errors':errors,'upstream_requests':0,'at':time.time()},last_error=None)
                    atomic_json(self.directory/'state.json',state)
                    if start_after and not self.sync_cancel.is_set():
                        self.start()
                except Exception as error:
                    state.update(status='error',phase='Beatmap sync stopped',last_error=f'Could not load real beatmaps: {str(error)[:200]}')
                    atomic_json(self.directory/'state.json',state)
            self.sync_thread = threading.Thread(target=synchronize,daemon=True)
            self.sync_thread.start()
            return self.status()

    def watch(self, map_id=None):
        with self.lock:
            if not self.maps():
                raise ValueError('Load real beatmaps before recording an attempt')
            if map_id is not None and map_id not in {entry['id'] for entry in self.maps()}:
                raise ValueError('Unknown beatmap')
            control = read_json(self.directory/'control.json',{'running':False})
            request = {'id':uuid.uuid4().hex,'seed':int.from_bytes(os.urandom(4),'little')%(2**31),'map_id':map_id}
            control['watch'] = request
            atomic_json(self.directory/'control.json',control)
            self._spawn(watch=not control.get('running'))
            return request

    def import_map(self, text):
        data = parse_beatmap(text)
        if len(json.dumps(data,separators=(',',':')).encode())>4*1024*1024:
            raise ValueError('Expanded beatmap geometry exceeds 4 MB')
        map_id = data['source_sha256'][:24]
        with self.lock:
            if not (self.directory/'maps'/f'{map_id}.json').exists() and len(self.maps())>=100:
                raise ValueError('Maximum 100 real beatmaps')
            atomic_bytes(self.directory/'maps'/f'{map_id}.osu',text.encode())
            atomic_json(self.directory/'maps'/f'{map_id}.json',data)
        return {'id':map_id,'title':data['title'],'objects':len(data['objects']),'counts':data['counts']}

    def import_checkpoint(self, data):
        policy, metadata = Policy.load(data)
        if metadata.get('training_format')!='real-beatmap-v1':
            raise ValueError('Expected a checkpoint trained on real beatmaps')
        if metadata.get('migrated_from_observation'):
            metadata.update(history=[],baselines={})
        # A checkpoint is a program state, so validate progress metadata too.
        for key in ['updates', 'steps', 'episodes', 'completed_maps', 'stage', 'seed']:
            value = metadata.get(key, 0)
            if type(value) is not int or not 0 <= value <= 10**12:
                raise ValueError('Invalid training progress in checkpoint')
        if metadata.get('seed', 0) > 2147483647:
            raise ValueError('Invalid random seed')
        history = metadata.get('history', [])
        if not isinstance(history, list) or len(history) > 300:
            raise ValueError('Invalid training history')
        for point in history:
            if not isinstance(point, dict) or any(type(point.get(key)) not in (float, int) or not 0 <= point[key] <= 1 for key in ['accuracy', 'hit_rate', 'baseline']):
                raise ValueError('Invalid training history')
        baselines = metadata.get('baselines', {})
        if not isinstance(baselines, dict) or len(baselines)>100:
            raise ValueError('Invalid starting-model comparisons')
        for stage, result in baselines.items():
            if not isinstance(stage,str) or len(stage)>1024 or not isinstance(result,dict):
                raise ValueError('Invalid starting-model comparison')
            if any(type(result.get(key)) not in (float, int) or not 0 <= result[key] <= 1 for key in ['accuracy', 'hit_rate']):
                raise ValueError('Invalid starting-model comparison')
        if 'rng' in metadata:
            import numpy as np
            try:
                np.random.default_rng().bit_generator.state = metadata['rng']
            except (ValueError, TypeError, KeyError):
                raise ValueError('Invalid random generator state') from None
        with self.lock:
            if self.process and self.process.poll() is None:
                raise ValueError('Pause training before importing a checkpoint')
            latest = self.directory/'models/latest.npz'
            if latest.exists():
                atomic_bytes(self.directory/'models/before-import.npz', latest.read_bytes())
            policy.save(latest, metadata)
            (self.directory/'models/latest-run.json').unlink(missing_ok=True)
            state = read_json(self.directory/'state.json', {})
            state.update({key: metadata.get(key, [] if key == 'history' else {} if key == 'baselines' else 0) for key in ['updates', 'steps', 'episodes', 'completed_maps', 'stage', 'history', 'baselines', 'seed']})
            state.pop('map_progress',None)
            state.update({'status': 'paused', 'phase': 'Checkpoint imported', 'last_error': None})
            atomic_json(self.directory/'state.json', state)
        return {'parameters': policy.parameter_count, 'updates': metadata.get('updates', 0)}

    def close(self):
        self.pause()
        if self.sync_thread and self.sync_thread.is_alive():
            self.sync_thread.join(timeout=12)
        self.monitor_stop.set()
        self.monitor.join(timeout=2)
        if self.log_handle:
            self.log_handle.close()


class Handler(BaseHTTPRequestHandler):
    server_version = 'OsuRival'

    def log_message(self, fmt, *args):
        if self.path.split('?', 1)[0] not in ['/api/status', '/api/scene', '/api/frame', '/health']:
            print(f'{self.command} {self.path.split("?",1)[0]} {args[1] if len(args)>1 else ""}', flush=True)

    def send(self, value, status=200, content_type='application/json', filename=None):
        body = json.dumps(value, allow_nan=False).encode() if content_type == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store' if self.path.startswith('/api/') else 'no-cache')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'")
        if filename:
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path
        controller = self.server.controller
        try:
            if path == '/health':
                return self.send({'status': 'ok', 'version': VERSION})
            if path == '/api/status':
                return self.send(controller.status())
            if path in ['/api/scene', '/api/attempt']:
                name = 'scene.json' if path.endswith('scene') else 'attempt.json'
                return self.send(read_json(controller.directory/name, {}))
            if path == '/api/frame':
                frame = controller.directory/'frame.png'
                if not frame.exists():
                    return self.send({'error': 'No attempt yet'}, 404)
                return self.send(frame.read_bytes(), content_type='image/png')
            if path.startswith('/api/checkpoints/'):
                name = path.removeprefix('/api/checkpoints/')
                if name not in {item['name'] for item in controller.checkpoints()}:
                    return self.send({'error': 'Checkpoint not found'}, 404)
                return self.send((controller.directory/'models'/name).read_bytes(), content_type='application/octet-stream', filename=name)
            if path in ['/', '/index.html', '/app.js', '/style.css', '/icon.svg']:
                name = 'index.html' if path == '/' else path[1:]
                file = self.server.web/name
                return self.send(file.read_bytes(), content_type=mimetypes.guess_type(name)[0] or 'application/octet-stream')
            self.send({'error': 'Not found'}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self.send({'error': 'File is unavailable'}, 404)

    def do_POST(self):
        origin = self.headers.get('Origin')
        # Ingress strips its prefix but preserves the browser origin. Compare
        # authority only, since a TLS terminator may forward plain HTTP.
        forwarded = self.headers.get('X-Forwarded-Host') or self.headers.get('Host', '')
        if origin and urlsplit(origin).netloc.lower() != forwarded.lower():
            return self.send({'error': 'Cross-origin requests are not allowed'}, 403)
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self.send({'error': 'Cross-origin requests are not allowed'}, 403)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > 4*1024*1024:
                return self.send({'error': 'Request exceeds the 4 MB limit'}, 413)
            content_type = self.headers.get('Content-Type', '').split(';', 1)[0]
            if content_type != 'application/json':
                return self.send({'error': 'Use application/json'}, 415)
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object')
            path = urlsplit(self.path).path
            controller = self.server.controller
            if path == '/api/training/start':
                return self.send(controller.start())
            if path == '/api/training/pause':
                return self.send(controller.pause())
            if path == '/api/watch':
                return self.send(controller.watch(data.get('map_id')), 202)
            if path == '/api/maps/sync':
                return self.send(controller.sync_maps(),202)
            if path == '/api/maps':
                if not isinstance(data.get('text'), str):
                    raise ValueError('Expected .osu file text')
                return self.send(controller.import_map(data['text']), 201)
            if path == '/api/checkpoints/import':
                import base64
                if not isinstance(data.get('data'), str):
                    raise ValueError('Expected checkpoint data')
                return self.send(controller.import_checkpoint(base64.b64decode(data['data'], validate=True)))
            self.send({'error': 'Not found'}, 404)
        except (ValueError, KeyError, TypeError, EOFError, zipfile.BadZipFile) as error:
            self.send({'error': str(error)[:300]}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            print(f'Control request failed: {type(error).__name__}', flush=True)
            self.send({'error': 'The action failed. Check the app log.'}, 500)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data', default='/data')
    parser.add_argument('--port', type=int, default=8099)
    parser.add_argument('--host', default='0.0.0.0')
    args = parser.parse_args()
    # The server needs no host administration privileges. Read Supervisor's
    # options before dropping the container's initial root identity.
    options = read_json(Path(args.data)/'options.json', {})
    if os.getuid() == 0:
        import pwd
        try:
            account = pwd.getpwnam('rival')
            os.setgroups([])
            os.setgid(account.pw_gid)
            os.setuid(account.pw_uid)
        except KeyError:
            raise RuntimeError('Container is missing the rival service user')
    controller = Controller(args.data, options)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.controller = controller
    server.web = Path(__file__).resolve().parent.parent/'web'
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(f'osu! Rival {VERSION} listening on {args.port}', flush=True)
    try:
        server.serve_forever(poll_interval=.25)
    finally:
        controller.close()
        server.server_close()


if __name__ == '__main__':
    main()
