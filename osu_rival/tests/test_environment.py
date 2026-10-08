import copy
import math
import tempfile
from pathlib import Path
import unittest
import numpy as np

from _maps import real_map
from rival.environment import Environment,FRAME_MS,parse_beatmap
from rival.beatmaps import slider_position,MapLibrary
from rival.storage import atomic_json


def aim(x,y):
    return np.arctanh(np.clip(np.array([x/256-1,y/192-1]),-.999999,.999999))

class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.map=real_map()

    def single(self,kind):
        beatmap=copy.deepcopy(self.map)
        beatmap['objects']=[next(obj for obj in beatmap['objects'] if obj['kind']==kind)]
        return Environment(beatmap=beatmap)

    def test_no_map_means_no_generated_fallback(self):
        with self.assertRaisesRegex(ValueError,'real beatmap'):Environment()

    def test_observation_is_pixels_and_real_authored_objects_are_retained(self):
        env=Environment(beatmap=self.map)
        self.assertEqual(env.observation().shape,(4,48,64))
        self.assertEqual(env.observation().dtype,np.uint8)
        self.assertEqual(len(env.objects),sum(self.map['counts'].values()))
        self.assertEqual({obj['kind'] for obj in env.objects},{'circle','slider','spinner'})
        for original,actual in zip(self.map['objects'],env.objects):
            self.assertEqual(original['x'],actual['x']);self.assertEqual(original['y'],actual['y'])
            self.assertAlmostEqual(original['time'],actual['time']+env.origin)
            self.assertAlmostEqual(original['end_time'],actual['end_time']+env.origin)

    def test_circle_is_rewarded_once_and_held_key_needs_release(self):
        env=self.single('circle');obj=env.objects[0];target=aim(obj['x'],obj['y'])
        env.step((target,1));env.time=obj['time']
        self.assertEqual(env.step((target,1))[1],0)
        env.step((target,0));_,reward,done=env.step((target,1))
        self.assertEqual(reward,1);self.assertTrue(done)
        self.assertEqual(env.step((target,1))[1],0)

    def test_misses_are_penalized_once(self):
        env=self.single('circle');env.time=env.objects[0]['time']+env.windows[-1]
        _,reward,done=env.step((aim(0,0),0))
        self.assertEqual(reward,-.5);self.assertTrue(done)
        self.assertEqual(env.step((aim(0,0),0))[1],0)

    def test_slider_requires_tracking_and_uses_real_timing(self):
        env=self.single('slider');obj=env.objects[0];env.time=obj['time']
        env.step((aim(obj['x'],obj['y']),1))
        while obj['result'] is None:
            env.step((aim(*slider_position(obj,min(env.time+FRAME_MS,obj['end_time']))),1))
        self.assertEqual(obj['result'],300)
        self.assertEqual(obj['components_hit'],len(obj['checkpoints'])+1)
        idle=self.single('slider')
        while idle.objects[0]['result'] is None:idle.step((aim(0,0),0))
        self.assertEqual(idle.objects[0]['result'],0)

    def test_spinner_requires_held_rotation_and_is_not_a_click_circle(self):
        env=self.single('spinner');obj=env.objects[0];env.time=obj['time'];step=0
        while obj['result'] is None:
            angle=step*.49
            env.step((aim(256+100*math.cos(angle),192+100*math.sin(angle)),1));step+=1
        self.assertEqual(obj['result'],300)
        idle=self.single('spinner');idle.time=idle.objects[0]['end_time']
        idle.step((aim(256,192),1));self.assertEqual(idle.objects[0]['result'],0)

    def test_scene_snapshot_does_not_mutate_when_inputs_are_applied(self):
        env=self.single('circle');scene=env.scene();env.time=env.objects[0]['time']
        env.step((aim(env.objects[0]['x'],env.objects[0]['y']),1))
        self.assertIsNone(scene['objects'][0]['result']);self.assertEqual(env.events[0]['id'],0)

    def test_train_and_test_sections_do_not_share_objects(self):
        with tempfile.TemporaryDirectory() as directory:
            atomic_json(Path(directory)/'real.json',self.map);library=MapLibrary(directory)
            training={(map['source_sha256'],i) for map,start,end in library.training for i in range(start,end)}
            testing={(map['source_sha256'],i) for map,start,end in library.testing for i in range(start,end)}
            self.assertTrue(training);self.assertTrue(testing);self.assertFalse(training&testing)
            self.assertEqual(len(training|testing),len(self.map['objects']))

class ParserTests(unittest.TestCase):
    def test_wrong_mode_and_nonfinite_values_are_rejected(self):
        with self.assertRaises(ValueError):parse_beatmap('osu file format v14\n[General]\nMode:3')
        with self.assertRaises(ValueError):parse_beatmap('osu file format v14\n[Difficulty]\nCircleSize:nan')

if __name__=='__main__':unittest.main()
