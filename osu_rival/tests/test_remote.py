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
    def test_gpu_runs_learn_and_pause_keeps_replies_rngs_and_playheads(self):
        from rival.accelerator import capabilities
        if not capabilities()['available']: self.skipTest('Optional GPU runtime is not available')
        policy = Policy(3)
        trainer = Trainer(policy, self.library, Path(self.temporary.name)/'maps', 2, 2, 7, device='gpu')
        resumed = None
        try:
            result = trainer.update(np.random.default_rng(1), steps=16, epochs=1, minibatch=32)
            self.assertEqual(result['steps'], 32)
            self.assertGreater(policy.optimizer_step, 0)
            self.assertTrue(np.isfinite(result['loss']))
            before = trainer.snapshot()
            weights = policy.serialize({})
            def pause(env, index):
                if index == 3: raise InterruptedError('pause GPU rollout')
            with self.assertRaises(InterruptedError):
                trainer.update(np.random.default_rng(1), steps=16, progress=pause)
            saved = trainer.snapshot()
            self.assertEqual(weights, policy.serialize({}))
            for old, new in zip(before['shards'], saved['shards']):
                self.assertGreater(new['runs'][0]['time'], old['runs'][0]['time'])
                self.assertNotEqual(new['rng'], old['rng'])
            resumed = Trainer(policy, self.library, Path(self.temporary.name)/'maps', 2, 2, 7)
            self.assertTrue(resumed.restore(saved))
            self.assertEqual(saved, resumed.snapshot())
        finally:
            if resumed: resumed.close()
            trainer.close()

    def test_changing_cores_and_run_count_keeps_active_and_waiting_maps(self):
        root = Path(self.temporary.name)
        policy = Policy(3)
        trainer = Trainer(policy, self.library, root/'maps', 4, 2, 7)
        try:
            trainer.update(np.random.default_rng(1), steps=16, minibatch=32, epochs=1)
            saved = trainer.snapshot()
        finally: trainer.close()
        expected = {i: r for s in saved['shards'] for i, r in zip(s['indices'], s['runs'])}
        for count, processes in [(4, 1), (2, 2), (4, 2)]:
            trainer = Trainer(policy, self.library, root/'maps', count, processes, 999)
            try:
                self.assertTrue(trainer.restore(saved))
                saved = trainer.snapshot()
                actual = {i: r for s in saved['shards'] for i, r in zip(s['indices'], s['runs'])}
                for i, run in actual.items(): self.assertEqual(run, expected[i])
                if count == 2: self.assertEqual(set(saved['waiting']), {'2', '3'})
            finally: trainer.close()

    def test_parallel_runs_reward_only_earned_judgment_points(self):
        trainer=Trainer(Policy(3),self.library,Path(self.temporary.name)/'maps',2,2,7)
        try:
            result=trainer.update(np.random.default_rng(1),steps=64,minibatch=32)
            saved=trainer.snapshot()
            points=sum(run['scoring']['points'] for shard in saved['shards'] for run in shard['runs'])
            self.assertEqual(result['steps'],128)
            self.assertAlmostEqual(result['reward'],points/300,places=5)
            self.assertAlmostEqual(result['reward'],result['score_reward'],places=5)
            self.assertEqual([r['index'] for r in trainer.scenes(limit=1)],[0])
            self.assertEqual(len(trainer.scenes()),2)
        finally:trainer.close()

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

    def test_every_parallel_run_and_random_state_survives_resume(self):
        policy=Policy(3);rng=np.random.default_rng(5)
        trainer=Trainer(policy,self.library,Path(self.temporary.name)/'maps',4,2,7)
        resumed=None
        try:
            trainer.update(rng,steps=16,minibatch=32,epochs=1)
            saved=trainer.snapshot();weights=policy.serialize({'training_format':'real-beatmap-v1'})
            before=[[run['time'] for run in shard['runs']] for shard in saved['shards']]
            replay_rng=np.random.default_rng();replay_rng.bit_generator.state=rng.bit_generator.state
            copy,_=Policy.load(weights)
            resumed=Trainer(copy,self.library,Path(self.temporary.name)/'maps',4,2,999)
            self.assertTrue(resumed.restore(saved))
            trainer.update(rng,steps=16,minibatch=32,epochs=1)
            resumed.update(replay_rng,steps=16,minibatch=32,epochs=1)
            self.assertEqual(trainer.snapshot(),resumed.snapshot())
            for shard,old in zip(resumed.snapshot()['shards'],before):
                self.assertTrue(all(run['time']>t for run,t in zip(shard['runs'],old)))
            for key in policy.parameters:np.testing.assert_array_equal(policy.parameters[key],copy.parameters[key])
        finally:
            if resumed:resumed.close()
            trainer.close()

    def test_each_environment_plays_its_own_maps(self):
        from rival.environment import Environment
        first = [Environment(seed=1, library=self.library, map_index=i, map_stride=3).beatmap['id'] for i in range(3)]
        self.assertEqual(len(set(first)), min(3, len(self.library.training)))

    def test_pause_during_rollout_keeps_process_replies_and_views_in_order(self):
        trainer=Trainer(Policy(3),self.library,Path(self.temporary.name)/'maps',4,2,7)
        try:
            def stop(env,index):raise InterruptedError('pause')
            with self.assertRaises(InterruptedError):trainer.update(np.random.default_rng(1),steps=16,progress=stop)
            saved=trainer.snapshot()
            self.assertTrue(all('indices' in shard and 'runs' in shard for shard in saved['shards']))
            self.assertTrue(trainer.restore(saved))
            scenes=trainer.scenes()
            self.assertEqual([run['index'] for run in scenes],list(range(4)))
            self.assertTrue(all('objects' in run['scene'] and run['scene']['time']>0 for run in scenes))
        finally:trainer.close()

    def test_resumed_primary_gets_different_initial_companion_maps(self):
        from rival.environment import Environment
        first=Environment(library=self.library,map_index=1)
        trainer=Trainer(Policy(3),self.library,Path(self.temporary.name)/'maps',2,2,7,first=first)
        try:
            ids=[run['scene']['map']['id'] for run in trainer.scenes()]
            self.assertEqual(len(set(ids)),min(2,len(self.library.training)))
        finally:trainer.close()

    def test_pi_only_checkpoint_preserves_waiting_pc_runs(self):
        from rival.worker import Worker
        from rival.storage import atomic_json,read_json
        root=Path(self.temporary.name)
        atomic_json(root/'worker-options.json',{'parallel_envs':1})
        worker=Worker(root)
        trainer=Trainer(worker.policy,self.library,root/'maps',4,2,7,first=worker.env)
        try:
            trainer.update(np.random.default_rng(1),steps=8,epochs=1,minibatch=32)
            worker.parallel_saved=trainer.snapshot();worker.checkpoint()
            saved=read_json(root/'models/latest-run.json')['parallel']
        finally:trainer.close()
        single=Worker(root)
        single.env.step((np.zeros(2),0));single.checkpoint()
        following=read_json(root/'models/latest-run.json')['parallel']
        for before,after in zip(saved['shards'],following['shards']):
            for index,a,b in zip(before['indices'],before['runs'],after['runs']):
                if index:self.assertEqual(a,b)
                else:self.assertGreater(b['time'],a['time'])


class HubTests(unittest.TestCase):
    def test_resource_settings_are_validated_persisted_and_do_not_pause_or_reset(self):
        status, body = self.attach()
        self.session = json.loads(body)['session']
        from rival.storage import atomic_json
        root = Path(self.temporary.name)
        control = read_json(root/'control.json') | {'running': True}
        atomic_json(root/'control.json', control)
        generation = self.controller.models_library.generation
        with self.assertRaises(ValueError): self.controller.trainer_settings({'processes': 17, 'environments': 32, 'device': 'cpu'})
        with self.assertRaises(ValueError): self.controller.trainer_settings({'processes': True, 'environments': 4, 'device': 'cpu'})
        with self.assertRaises(ValueError): self.controller.trainer_settings({'processes': 4, 'environments': 2, 'device': 'cpu'})
        with self.assertRaises(ValueError): self.controller.trainer_settings({'processes': 2, 'environments': 4, 'device': 'gpu'})
        self.controller.trainer_settings({'processes': 1, 'environments': 4, 'device': 'cpu'})
        self.assertEqual(read_json(root/'control.json'), control)
        self.assertEqual(self.controller.models_library.generation, generation)
        wanted = self.controller.remote_control()['trainer_settings']
        self.assertEqual((wanted['processes'], wanted['environments']), (1, 4))
        self.assertEqual(read_json(root/'trainer-settings.json'), wanted)
        self.controller.remote_store('state.json', {'trainer_settings': wanted}, generation)
        self.assertEqual(self.controller.status()['remote']['attached']['processes'], 1)
        atomic_json(root/'control.json', control | {'running': False})

    def test_recommended_setup_replaces_old_tuning_once_and_keeps_manual_choices(self):
        from rival.storage import atomic_json
        root=Path(self.temporary.name)
        atomic_json(root/'trainer-settings.json',{'processes':8,'environments':64,'device':'cpu','id':'old'})
        self.session=json.loads(self.attach()[1])['session']
        recommended=self.controller.remote_control()['trainer_settings']
        self.assertEqual((recommended['processes'],recommended['environments'],recommended['device']),(4,8,'cpu'))
        self.controller.trainer_settings({'processes':2,'environments':4,'device':'cpu'})
        manual=self.controller.remote_control()['trainer_settings']
        self.assertFalse(manual['automatic'])
        self.attach(session=self.session)
        self.assertEqual(manual,self.controller.remote_control()['trainer_settings'])
        self.controller.trainer_settings({'recommended':True})
        self.assertTrue(self.controller.remote_control()['trainer_settings']['automatic'])

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
        headers = {'Authorization': f'Bearer {token or self.controller.remote_token}', 'X-Rival-Session':self.session,'X-Rival-Model':self.controller.models_library.generation}
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

    def test_control_heartbeat_requires_owning_session(self):
        status,body=self.attach();self.session=json.loads(body)['session']
        self.assertEqual(self.call('GET','/control')[0],200)
        self.session='stale-session';before=self.controller.remote['seen']
        self.assertEqual(self.call('GET','/control')[0],409)
        self.assertEqual(self.controller.remote['seen'],before)

    def test_disconnected_mirror_stops_local_training(self):
        from rival.remote import Mirror
        from rival.storage import atomic_json
        class LostHub:
            model_generation=''
            def request(self,*args,**kwargs):raise OSError('Connection lost')
        with tempfile.TemporaryDirectory() as directory:
            atomic_json(Path(directory)/'control.json',{'running':True})
            mirror=Mirror(LostHub(),directory);mirror.start()
            try:
                self.assertTrue(mirror.disconnected.wait(3))
                deadline=time.monotonic()+1
                while read_json(Path(directory)/'control.json')['running'] and time.monotonic()<deadline:time.sleep(.01)
                self.assertFalse(read_json(Path(directory)/'control.json')['running'])
            finally:mirror.stop.set();mirror.join(timeout=2)

    def test_a_different_version_or_second_trainer_is_refused(self):
        self.assertEqual(self.attach(version='0.0.1')[0], 400)
        self.assertEqual(self.attach()[0], 200)
        status, body = self.attach(name='other-pc')
        self.assertEqual(status, 400)
        self.assertIn('already training', json.loads(body)['error'])

    def test_idle_pc_acknowledges_saved_pause_before_model_changes(self):
        from rival.remote import Hub,Mirror,sync
        from rival.storage import atomic_json
        self.controller.manage_model('new',{'name':'Existing model'})
        state=read_json(Path(self.temporary.name)/'state.json')
        import os
        atomic_json(Path(self.temporary.name)/'state.json',state|{'pid':os.getpid()})
        hub=Hub(self.url.removesuffix('/remote/v1'),self.controller.remote_token)
        attached=hub.request('POST','/attach',{'name':'test-pc','cores':2,'processes':1,'environments':2,'version':VERSION})
        hub.session=attached['session']
        with tempfile.TemporaryDirectory() as directory:
            sync(hub,directory)
            mirror=Mirror(hub,directory);mirror.start()
            try:
                self.controller.pause(wait_remote=True)
                pause_id=read_json(Path(self.temporary.name)/'control.json')['pause_id']
                deadline=time.monotonic()+3
                while time.monotonic()<deadline and read_json(Path(self.temporary.name)/'state.json',{}).get('pause_id')!=pause_id:time.sleep(.05)
                self.assertEqual(read_json(Path(self.temporary.name)/'state.json')['pause_id'],pause_id)
            finally:mirror.stop.set();mirror.join(timeout=5)

    def test_selecting_new_model_clears_old_pc_best_checkpoint(self):
        from rival.remote import Hub,sync
        hub=Hub(self.url.removesuffix('/remote/v1'),self.controller.remote_token)
        attached=hub.request('POST','/attach',{'name':'test-pc','cores':2,'processes':1,'environments':2,'version':VERSION})
        hub.session=attached['session']
        with tempfile.TemporaryDirectory() as directory:
            sync(hub,directory)
            path=Path(directory)/'models/best.npz';path.write_bytes(b'old model best')
            self.controller.remote['seen']=0
            self.controller.manage_model('new',{'name':'Fresh rival'})
            sync(hub,directory)
            self.assertFalse(path.exists())
            _,metadata=Policy.load((Path(directory)/'models/latest.npz').read_bytes())
            self.assertEqual(metadata['steps'],0)
            self.assertEqual(hub.model_generation,self.controller.models_library.generation)

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
