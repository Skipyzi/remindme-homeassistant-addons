"""Parallel training and the remote training hub. Light by design: at most two processes and a few seconds."""
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from http.server import ThreadingHTTPServer
import numpy as np

from rival import VERSION
from rival.beatmaps import MapLibrary
from rival.hub import RemoteHandler
from rival.parallel import Trainer
from rival.policy import Policy
from rival.server import Controller
from rival.storage import read_json
from _maps import real_maps


def library_with(directory, count=3):
    controller = Controller(directory, {'cpu_budget_percent': 100, 'min_available_memory_mb': 256})
    from rival.beatmaps import parse_beatmap  # noqa: F401  (maps come from RIVAL_TEST_MAP)
    import os
    source = Path(os.environ['RIVAL_TEST_MAP']).parent
    for file in sorted(source.glob('*.osu'))[:count]:
        controller.import_map(file.read_text(encoding='utf-8-sig'))
    controller.close()
    return MapLibrary(Path(directory)/'maps')


class ParallelTests(unittest.TestCase):
    def setUp(self):
        real_maps()   # skips without real beatmaps
        self.temporary = tempfile.TemporaryDirectory()
        self.library = library_with(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def update(self, environments, processes):
        policy = Policy(3)
        before = {key: value.copy() for key, value in policy.parameters.items()}
        trainer = Trainer(policy, self.library, Path(self.temporary.name)/'maps', environments, processes, 7)
        try:
            result = trainer.update(np.random.default_rng(1), steps=32, minibatch=32)
            shared = max(float(np.abs(trainer.local.policy.parameters[key] - policy.parameters[key]).max()) for key in before)
        finally:
            trainer.close()
        moved = max(float(np.abs(policy.parameters[key] - before[key]).max()) for key in before)
        return result, moved, shared

    def test_one_update_learns_from_every_environment(self):
        result, moved, shared = self.update(2, 1)
        self.assertEqual((result['steps'], result['environments'], result['processes']), (64, 2, 1))
        self.assertGreater(moved, 0)
        self.assertEqual(shared, 0, 'the playing network always uses the learned weights')
        self.assertTrue(np.isfinite(result['loss']))

    def test_a_second_process_trains_the_same_way(self):
        result, moved, shared = self.update(2, 2)
        self.assertEqual((result['steps'], result['processes']), (64, 2))
        self.assertGreater(moved, 0)
        self.assertEqual(shared, 0)

    def test_each_environment_plays_its_own_maps(self):
        from rival.environment import Environment
        first = [Environment(seed=1, library=self.library, map_index=i, map_stride=3).beatmap['id'] for i in range(3)]
        self.assertEqual(len(set(first)), min(3, len(self.library.training)))


class HubTests(unittest.TestCase):
    def setUp(self):
        real_maps()
        self.temporary = tempfile.TemporaryDirectory()
        library_with(self.temporary.name, 2)
        self.controller = Controller(self.temporary.name, {'cpu_budget_percent': 100, 'min_available_memory_mb': 256, 'remote_training': True})
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), RemoteHandler)
        self.server.controller, self.server.token = self.controller, self.controller.remote_token
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_address[1]}/remote/v1'
        self.session = ''

    def tearDown(self):
        self.server.shutdown(); self.server.server_close()
        self.controller.close()
        self.temporary.cleanup()

    def call(self, method, path, data=None, token=None, content_type='application/json'):
        body = json.dumps(data).encode() if isinstance(data, dict) else data
        headers = {'Authorization': f'Bearer {token or self.controller.remote_token}', 'X-Rival-Session': self.session}
        if body is not None:
            headers['Content-Type'] = content_type
        request = urllib.request.Request(self.url + path, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()

    def attach(self, **changes):
        info = {'name': 'test-pc', 'cores': 16, 'processes': 2, 'environments': 4, 'version': VERSION, **changes}
        return self.call('POST', '/attach', info)

    def test_every_request_needs_the_token(self):
        self.assertEqual(self.call('GET', '/hello', token='wrong-token-wrong-token-xx')[0], 401)
        status, body = self.call('GET', '/hello')
        self.assertEqual(status, 200)
        hello = json.loads(body)
        self.assertEqual((hello['version'], len(hello['maps'])), (VERSION, 2))
        self.assertGreaterEqual(len(self.controller.remote_token), 24)

    def test_uploads_need_an_attached_session_and_valid_files(self):
        self.assertEqual(self.call('PUT', '/files/state.json', b'{}')[0], 409)
        status, body = self.attach()
        self.assertEqual(status, 200)
        self.session = json.loads(body)['session']
        self.assertEqual(self.call('PUT', '/files/state.json', json.dumps({'status': 'training', 'updates': 3}).encode())[0], 200)
        self.assertEqual(read_json(Path(self.temporary.name)/'state.json')['updates'], 3)
        self.assertEqual(self.call('PUT', '/files/models/latest.npz', b'not a checkpoint', content_type='application/octet-stream')[0], 400)
        self.assertEqual(self.call('PUT', '/files/options.json', b'{}')[0], 404, 'only the worker\'s own files are writable')
        self.assertEqual(self.call('PUT', '/files/frame.png', b'GIF89a')[0], 400)
        self.assertEqual(self.call('GET', '/files/remote-token')[0], 404)
        status = self.controller.status()
        self.assertEqual((status['trainer'], status['remote']['attached']['name']), ('remote', 'test-pc'))
        self.assertEqual(self.call('POST', '/detach', {'session': self.session})[0], 200)
        self.assertEqual(self.controller.status()['trainer'], 'local')

    def test_a_different_version_or_second_trainer_is_refused(self):
        self.assertEqual(self.attach(version='0.0.1')[0], 400)
        self.assertEqual(self.attach()[0], 200)
        status, body = self.attach(name='other-pc')
        self.assertEqual(status, 400)
        self.assertIn('already training', json.loads(body)['error'])

    def test_remote_training_round_trip(self):
        """Attach, copy maps and model, train one parallel update, pause from the app, and find it on the hub."""
        from rival.remote import Hub, Mirror, sync
        from rival.storage import atomic_json
        from rival.worker import Worker
        hub = Hub(self.url.removesuffix('/remote/v1'), self.controller.remote_token)
        attached = hub.request('POST', '/attach', {'name': 'test-pc', 'cores': 2, 'processes': 1, 'environments': 2, 'version': VERSION})
        hub.session = attached['session']
        with tempfile.TemporaryDirectory() as local:
            hello, fetched = sync(hub, local)
            self.assertEqual(fetched, 2)
            atomic_json(Path(local)/'worker-options.json', {'seed': 1, 'cpu_budget_percent': 100, 'memory_limit_mb': 2048,
                                                            'min_available_memory_mb': 256, 'max_temperature_c': 95, 'parallel_envs': 2, 'processes': 1})
            self.controller.start()   # an attached trainer starts by itself; nothing is spawned here
            self.assertIsNone(self.controller.process)
            mirror = Mirror(hub, local)
            mirror.pull_control(); mirror.start()
            def pause_after_first_update():
                for _ in range(600):
                    if (read_json(Path(self.temporary.name)/'state.json') or {}).get('updates', 0) >= 1:
                        break
                    time.sleep(.1)
                self.controller.pause()
            threading.Thread(target=pause_after_first_update, daemon=True).start()
            worker = Worker(local)
            worker.run()
            mirror.stop.set(); mirror.join(timeout=5); mirror.push(force=True)
        state = read_json(Path(self.temporary.name)/'state.json')
        self.assertGreaterEqual(state['updates'], 1)
        self.assertEqual(state['parallel'], {'environments': 2, 'processes': 1})
        policy, metadata = Policy.load((Path(self.temporary.name)/'models/latest.npz').read_bytes())
        self.assertGreaterEqual(metadata['updates'], 1)
        scene = read_json(Path(self.temporary.name)/'scene.json')
        self.assertIn('trail', scene)


if __name__ == '__main__':
    unittest.main()
