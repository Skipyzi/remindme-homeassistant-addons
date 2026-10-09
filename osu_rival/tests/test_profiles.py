"""Private profile association without replays, training, or account mutations."""
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from rival.profiles import Profiles,public_url
from rival.server import Controller
from rival.storage import atomic_json,read_json

class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.calls=[];calls=self.calls
        class API(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                calls.append(self.path)
                users=[{'id':1,'username':'Notification bot','is_bot':True},{'id':3,'username':'Rival account','is_bot':True},{'id':4,'username':'Regular player','is_bot':False}]
                data={'users':users} if self.path=='/api/v2/users/' else users[1]
                raw=json.dumps(data).encode();self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        self.api=ThreadingHTTPServer(('127.0.0.1',0),API);threading.Thread(target=self.api.serve_forever,daemon=True).start()
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.controller=Controller(self.root,{'beatmap_server_url':f'http://127.0.0.1:{self.api.server_port}'})
        self.original=self.controller.models_library.index['active']
    def tearDown(self):
        self.controller.close();self.api.shutdown();self.api.server_close();self.tmp.cleanup()
    def link(self,ident=None):
        return self.controller.manage_model('profile',{'id':ident or self.original,'user_id':3,'website_url':'http://homeassistant.local:8087/'})
    def test_mapping_stays_with_its_model_after_switch_and_reload(self):
        result=self.link();profile=result['models'][0]['profile']
        self.assertEqual(profile['url'],'http://homeassistant.local:8087/#/players/3/osu')
        generation=result['generation']
        self.assertEqual(generation,self.controller.models_library.generation)
        fresh=self.controller.manage_model('new',{'name':'Different model'})['active']
        self.assertNotIn('profile',self.controller.models_library.find(fresh))
        self.controller.manage_model('activate',{'id':self.original})
        self.assertEqual(self.controller.models_library.find(self.original)['profile'],profile)
        from rival.models import Models
        self.assertEqual(Models(self.root).find(self.original)['profile'],profile)
        self.assertEqual(set(self.calls),{'/api/v2/users/','/api/v2/users/3/osu'})
    def test_link_and_unlink_leave_training_control_and_weights_alone(self):
        self.controller.manage_model('new',{'name':'A rival'});ident=self.controller.models_library.index['active']
        raw=(self.root/'models/latest.npz').read_bytes();generation=self.controller.models_library.generation
        control={'running':True,'model_generation':generation};atomic_json(self.root/'control.json',control)
        self.link(ident)
        self.controller.manage_model('profile',{'id':ident,'user_id':None})
        self.assertEqual(read_json(self.root/'control.json'),control)
        self.assertEqual((self.root/'models/latest.npz').read_bytes(),raw)
        self.assertEqual(self.controller.models_library.generation,generation)
        self.assertNotIn('profile',self.controller.models_library.find(ident))
    def test_unknown_or_reserved_profile_cannot_be_linked(self):
        for ident in [1,4,99,True,'3']:
            with self.assertRaises(ValueError):self.controller.manage_model('profile',{'id':self.original,'user_id':ident,'website_url':'http://server:8087'})
        self.assertNotIn('profile',self.controller.models_library.find(self.original))
        self.assertNotIn('/api/v2/users/99/osu',self.calls)
        self.assertNotIn('/api/v2/users/4/osu',self.calls)
        self.assertEqual([user['user_id'] for user in self.controller.profiles.choices()],[3])
    def test_unsafe_links_are_rejected(self):
        for value in ['javascript:alert(1)','https://user:secret@server','https://server/path','https://server/?x=1','https://server/#x','http://server:bad']:
            with self.assertRaises(ValueError):public_url(value)
