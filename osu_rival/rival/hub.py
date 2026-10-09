"""Remote training hub: lets a faster computer on the network train the model for this app.

When `remote_training` is on, the app also listens on `remote_port` (default 8100) for a trainer started with
`python -m rival.remote`. Every request needs the hub token. The trainer attaches, downloads the saved maps and the
latest model, and then trains with its own cores. It uploads what the local worker would have written (state,
live scene and frame, checkpoints, recorded attempts), so the web UI shows remote training exactly like local
training. Start, pause and watch in the UI keep working: the trainer follows control.json.
"""
import hashlib
import hmac
import io
import json
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import secrets
import tarfile
from urllib.parse import urlsplit
import zipfile

from . import VERSION
from .policy import Policy
from .storage import atomic_bytes, atomic_json, read_json

API = '/remote/v1'
READABLE = {'models/latest.npz', 'models/latest-run.json', 'models/initial.npz','models/best.npz', 'models/best.json'}
WRITABLE = {'state.json': 4, 'scene.json': 2, 'runs.json': 8, 'frame.png': .0625, 'attempt.json': 8, 'models/latest.npz': 4,
            'models/latest-run.json': 32, 'models/best.npz': 4, 'models/best.json': .0625}   # name: size limit in MB
PNG = b'\x89PNG\r\n\x1a\n'
PACKAGE = Path(__file__).resolve().parent


def hub_token(directory, configured=''):
    """The configured token, or one generated once and kept in the data directory."""
    if configured:
        return configured
    path = Path(directory)/'remote-token'
    token = path.read_text().strip() if path.exists() else ''
    if len(token) < 24:
        token = secrets.token_urlsafe(24)
        atomic_bytes(path, token.encode())
        path.chmod(0o600)
    return token


def package_archive():
    """The trainer code (this package) as a .tar.gz, so the remote computer runs exactly the hub's version."""
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for file in sorted(PACKAGE.glob('*.py')):
            archive.add(file, arcname=f'rival/{file.name}')
        notice=PACKAGE.parent/'THIRD_PARTY_NOTICES.md'
        if notice.is_file():archive.add(notice,arcname=notice.name)
    return stream.getvalue()


BOOTSTRAP = '''#!/usr/bin/env python3
"""osu! Rival remote trainer: downloads the trainer code from your Rival app and trains on this computer.

Run: python3 rival-trainer.py --hub http://HOME-ASSISTANT:8100 --token TOKEN [--processes N]
Needs Python 3.10+ with numpy and Pillow (python3 -m pip install --user numpy pillow).
"""
import argparse, io, os, sys, tarfile, urllib.request
from pathlib import Path


def bootstrap():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument('--hub', required=True)
    parser.add_argument('--token', required=True)
    known, _ = parser.parse_known_args()
    try:
        import numpy, PIL  # noqa: F401
    except ImportError:
        sys.exit('The trainer needs numpy and Pillow. Install them with: python3 -m pip install --user numpy pillow')
    request = urllib.request.Request(known.hub.rstrip('/') + '/remote/v1/package.tar.gz', headers={'Authorization': 'Bearer ' + known.token})
    with urllib.request.urlopen(request, timeout=30) as response:
        version, data = response.headers.get('X-Rival-Version', 'unknown'), response.read()
    home = Path(os.environ.get('XDG_CACHE_HOME', Path.home()/'.cache'))/'osu-rival-trainer'/version
    home.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        archive.extractall(home, filter='data')
    sys.path.insert(0, str(home))
    from rival.remote import main
    main()


# Worker processes are started with 'spawn' and re-import this file: only the first run may start the trainer.
if __name__ == '__main__':
    bootstrap()
'''


class RemoteHandler(BaseHTTPRequestHandler):
    server_version = 'OsuRivalHub'

    def log_message(self, fmt, *args):
        path = self.path.split('?', 1)[0]
        if not path.endswith(('/control', '/files/scene.json', '/files/frame.png', '/files/state.json')):
            print(f'remote {self.command} {path} {args[1] if len(args) > 1 else ""}', flush=True)

    def send(self, value, status=200, content_type='application/json', headers=None):
        body = json.dumps(value, allow_nan=False).encode() if content_type == 'application/json' else value
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        given = self.headers.get('Authorization', '')
        token = self.server.token
        if not given.startswith('Bearer ') or not hmac.compare_digest(given[7:].encode(), token.encode()):
            self.send({'error': 'A valid hub token is required'}, 401)
            return False
        return True

    def body(self, limit_mb):
        length = int(self.headers.get('Content-Length', '0'))
        if length <= 0 or length > limit_mb * 1024 * 1024:
            raise ValueError('Upload is empty or too large')
        return self.rfile.read(length)

    def do_GET(self):
        if not self.authorized():
            return
        path, controller = urlsplit(self.path).path, self.server.controller
        try:
            if path == f'{API}/hello':
                return self.send(controller.remote_hello())
            if path == f'{API}/control':
                if not controller.remote_owns(self.headers.get('X-Rival-Session','')):
                    return self.send({'error':'Attach the trainer first'},409)
                return self.send(controller.remote_control())
            if path.startswith(f'{API}/maps/') and path.endswith('.json'):
                map_id = path.removeprefix(f'{API}/maps/').removesuffix('.json')
                if not map_id.isalnum() or len(map_id) > 64:
                    return self.send({'error': 'Unknown map'}, 404)
                file = controller.directory/'maps'/f'{map_id}.json'
                return self.send(file.read_bytes(), content_type='application/json; charset=utf-8') if file.exists() else self.send({'error': 'Unknown map'}, 404)
            if path.startswith(f'{API}/files/'):
                name = path.removeprefix(f'{API}/files/')
                file = controller.directory/name
                if name not in READABLE:
                    return self.send({'error': 'Not available'}, 404)
                if not file.exists():
                    return self.send({'error': 'Not saved yet'}, 404)
                return self.send(file.read_bytes(), content_type='application/octet-stream')
            if path == f'{API}/package.tar.gz':
                return self.send(package_archive(), content_type='application/gzip', headers={'X-Rival-Version': VERSION})
            if path == f'{API}/trainer.py':
                return self.send(BOOTSTRAP.encode(), content_type='text/x-python')
            self.send({'error': 'Not found'}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError:
            self.send({'error': 'File is unavailable'}, 404)

    def do_POST(self):
        if not self.authorized():
            return
        path, controller = urlsplit(self.path).path, self.server.controller
        try:
            data = json.loads(self.body(.0625))
            if not isinstance(data, dict):
                raise ValueError('Expected a JSON object')
            if path == f'{API}/attach':
                return self.send(controller.remote_attach(data))
            if path == f'{API}/detach':
                return self.send(controller.remote_detach(data.get('session')))
            self.send({'error': 'Not found'}, 404)
        except (ValueError, TypeError) as error:
            self.send({'error': str(error)[:300]}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_PUT(self):
        if not self.authorized():
            return
        path, controller = urlsplit(self.path).path, self.server.controller
        try:
            name = path.removeprefix(f'{API}/files/')
            if not path.startswith(f'{API}/files/') or name not in WRITABLE:
                return self.send({'error': 'Not writable'}, 404)
            session = self.headers.get('X-Rival-Session', '')
            if not controller.remote_owns(session):
                return self.send({'error': 'Attach the trainer first'}, 409)
            data = self.body(WRITABLE[name])
            controller.remote_store(name,validate(name,data),self.headers.get('X-Rival-Model',''))
            self.send({'ok': True})
        except (ValueError, TypeError, KeyError, EOFError, zipfile.BadZipFile) as error:
            self.send({'error': str(error)[:300]}, 400)
        except (BrokenPipeError, ConnectionResetError):
            pass


def validate(name, data):
    """Uploaded files must be what the worker would write: checked models, JSON objects, a small PNG."""
    if name.endswith('.npz'):
        _, metadata = Policy.load(data)
        if metadata.get('training_format') != 'real-beatmap-v1':
            raise ValueError('Expected a real-beatmap checkpoint')
        return data
    if name.endswith('.png'):
        if not data.startswith(PNG):
            raise ValueError('Expected a PNG frame')
        return data
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError('Expected a JSON object')
    return value
