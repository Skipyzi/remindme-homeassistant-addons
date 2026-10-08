import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from http.server import ThreadingHTTPServer
from rival.server import Controller, Handler
from _maps import real_map


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory()
        self.controller=Controller(self.temporary.name,{'cpu_budget_percent':100,'min_available_memory_mb':256})
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.controller=self.controller
        self.server.web=Path(__file__).resolve().parent.parent/'web'
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown();self.controller.close();self.server.server_close();self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self,path,data=None,headers=None):
        request=urllib.request.Request(self.base+path,data=json.dumps(data).encode() if data is not None else None,
                                      headers={'Content-Type':'application/json',**(headers or {})})
        return urllib.request.urlopen(request,timeout=10)

    def wait(self,predicate,timeout=12):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            if predicate():return
            time.sleep(.1)
        self.fail('Worker did not reach the expected state')

    def test_start_pause_and_resume_retains_training_progress(self):
        map=real_map()
        self.controller.import_map(Path(os.environ['RIVAL_TEST_MAP']).read_text(encoding='utf-8-sig'))
        with self.request('/api/training/start',{}) as response:self.assertEqual(response.status,200)
        pid=self.controller.process.pid
        self.controller.start();self.assertEqual(self.controller.process.pid,pid)
        self.wait(lambda:self.controller.status().get('updates',0)>=1)
        before=self.controller.status()['steps'];self.assertGreater(before,0)
        self.controller.pause();self.assertIsNotNone(self.controller.process.poll())
        self.assertTrue((Path(self.temporary.name)/'models/latest.npz').exists())
        saved=json.loads((Path(self.temporary.name)/'models/latest-run.json').read_text())
        self.controller.start();self.wait(lambda:self.controller.status().get('steps',0)>before)
        self.controller.pause()
        resumed=json.loads((Path(self.temporary.name)/'models/latest-run.json').read_text())
        self.assertEqual(resumed['run']['map_id'],saved['run']['map_id'])
        self.assertGreater(resumed['run']['time'],saved['run']['time'])
        self.assertEqual(len(resumed['run']['objects']),len(map['objects']))

    def test_watch_uses_saved_policy_and_full_practice_window(self):
        map=real_map()
        self.controller.import_map(Path(os.environ['RIVAL_TEST_MAP']).read_text(encoding='utf-8-sig'))
        request=self.controller.watch()
        file=Path(self.temporary.name)/'attempt.json'
        self.wait(file.exists,timeout=60)
        data=json.loads(file.read_text())
        self.assertEqual(data['id'],request['id'])
        self.assertEqual(data['summary']['objects'],len(map['objects']))
        self.assertEqual(data['scene']['map']['source_sha256'],map['source_sha256'])
        self.assertTrue(data['frames'])
        self.assertGreater(data['frames'][-1][0],data['scene']['end_time']-20)
        self.assertFalse(json.loads((Path(self.temporary.name)/'control.json').read_text())['running'])

    def test_legacy_practice_checkpoint_is_not_used_for_real_map_training(self):
        from rival.policy import Policy
        with self.assertRaisesRegex(ValueError,'real beatmaps'):
            self.controller.import_checkpoint(Policy().serialize({'seed':42,'updates':100}))
        self.assertFalse((Path(self.temporary.name)/'models/latest.npz').exists())

    def test_cross_origin_mutation_is_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request('/api/training/start',{},headers={'Origin':'https://unrelated.example'})
        self.assertEqual(caught.exception.code,403)
        caught.exception.close()
        self.assertIsNone(self.controller.process)

    def test_static_path_traversal_cannot_read_app_data(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:self.request('/../options.json')
        self.assertEqual(caught.exception.code,404)
        caught.exception.close()

    def test_unimplemented_server_play_is_explicit(self):
        with self.request('/api/status') as response:data=json.load(response)
        self.assertFalse(data['server_play']['available'])


if __name__ == '__main__':
    unittest.main()
