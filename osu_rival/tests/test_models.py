import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import numpy as np

from _maps import real_map
from rival.environment import Environment
from rival.policy import Policy,update
from rival.server import Controller
from rival.storage import atomic_json,atomic_bytes,read_json


class ModelTests(unittest.TestCase):
    def setUp(self):
        beatmap=real_map()
        self.temporary=tempfile.TemporaryDirectory();self.root=Path(self.temporary.name)
        self.controller=Controller(self.root,{'cpu_budget_percent':100,'min_available_memory_mb':256})
        from rival.beatmaps import MapLibrary
        atomic_json(self.root/'maps'/(beatmap['source_sha256'][:24]+'.json'),beatmap)
        policy=Policy(5);rng=np.random.default_rng(5);env=Environment(library=MapLibrary(self.root/'maps'))
        update(policy,env,rng,steps=32,epochs=1)
        metadata={'seed':5,'steps':32,'updates':1,'episodes':0,'completed_maps':0,'stage':0,'history':[],'baselines':{},'rng':rng.bit_generator.state,'training_format':'real-beatmap-v1','training_strategy':'full-maps-v1'}
        self.raw=policy.serialize(metadata);atomic_bytes(self.root/'models/latest.npz',self.raw)
        Policy(5).save(self.root/'models/initial.npz',metadata|{'steps':0,'updates':0})
        self.run={'checkpoint_sha256':hashlib.sha256(self.raw).hexdigest(),'run':env.save_run()}
        atomic_json(self.root/'models/latest-run.json',self.run)
        atomic_json(self.root/'state.json',metadata|{'status':'paused'})
        self.original=self.controller.models_library.index['active']

    def tearDown(self):self.controller.close();self.temporary.cleanup()

    def test_new_model_keeps_previous_model_and_switch_restores_exact_progress(self):
        result=self.controller.manage_model('new',{'name':'Second rival'})
        fresh=result['active'];self.assertNotEqual(fresh,self.original)
        self.assertEqual(self.controller.status()['steps'],0)
        self.assertNotEqual((self.root/'models/latest.npz').read_bytes(),self.raw)
        self.controller.manage_model('activate',{'id':self.original})
        self.assertEqual((self.root/'models/latest.npz').read_bytes(),self.raw)
        self.assertEqual(read_json(self.root/'models/latest-run.json'),self.run)
        self.assertEqual(self.controller.status()['steps'],32)
        self.assertEqual(len(self.controller.models_library.status()['models']),2)
        self.assertEqual(len(self.controller.maps()),1)

    def test_discard_inactive_model_preserves_active_weights_and_maps(self):
        fresh=self.controller.manage_model('new',{'name':'Discard me'})['active']
        self.controller.manage_model('activate',{'id':self.original})
        self.controller.manage_model('discard',{'id':fresh})
        self.assertFalse((self.root/'saved-models'/fresh).exists())
        self.assertEqual((self.root/'models/latest.npz').read_bytes(),self.raw)
        self.assertEqual(len(self.controller.maps()),1)
        self.assertEqual(len(self.controller.models_library.status()['models']),1)

    def test_discard_active_model_replaces_it_with_a_fresh_model(self):
        previous=self.controller.models_library.generation
        result=self.controller.manage_model('discard',{'id':self.original})
        self.assertNotEqual(result['active'],self.original)
        self.assertNotEqual(result['generation'],previous)
        self.assertFalse((self.root/'saved-models'/self.original).exists())
        self.assertEqual(self.controller.status()['steps'],0)
        self.assertEqual(len(result['models']),1)
        self.assertEqual(len(self.controller.maps()),1)
        self.assertEqual(read_json(self.root/'control.json')['model_generation'],result['generation'])

    def test_old_pc_upload_cannot_replace_newly_selected_model(self):
        self.controller.remote={'seen':0}
        old=self.controller.models_library.generation
        self.controller.manage_model('new',{'name':'Fresh model'})
        with self.assertRaisesRegex(ValueError,'active model changed'):
            self.controller.remote_store('models/latest.npz',self.raw,old)
        self.assertNotEqual((self.root/'models/latest.npz').read_bytes(),self.raw)
        self.controller.remote=None

    def test_checkpoint_import_invalidates_old_pc_uploads(self):
        old=self.controller.models_library.generation
        self.controller.import_checkpoint(self.raw)
        self.assertNotEqual(old,self.controller.models_library.generation)
        with self.assertRaisesRegex(ValueError,'active model changed'):
            self.controller.remote_store('models/latest.npz',self.raw,old)

    def test_incomplete_pc_checkpoint_sync_cannot_be_archived(self):
        atomic_json(self.root/'models/latest-run.json',self.run|{'checkpoint_sha256':'not-yet-matching'})
        with self.assertRaisesRegex(ValueError,'synchronizing'):
            self.controller.manage_model('new',{'name':'Another model'})
        self.assertEqual((self.root/'models/latest.npz').read_bytes(),self.raw)
        self.assertEqual(self.controller.models_library.index['active'],self.original)

    def test_invalid_names_and_model_ids_leave_progress_intact(self):
        for action,data in [('new',{'name':''}),('activate',{'id':'../../models'}),('discard',{'id':'missing'})]:
            with self.assertRaises(ValueError):self.controller.manage_model(action,data)
        self.assertEqual((self.root/'models/latest.npz').read_bytes(),self.raw)
        self.assertEqual(self.controller.models_library.index['active'],self.original)
