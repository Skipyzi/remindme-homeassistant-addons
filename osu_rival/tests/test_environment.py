import copy
import math
import tempfile
from pathlib import Path
import unittest
import numpy as np

from _maps import real_map,real_maps
from rival.environment import Environment,FRAME_MS,parse_beatmap
from rival.beatmaps import slider_position,MapLibrary
from rival.storage import atomic_json
from rival.vision import PADDING,PIXELS_PER_UNIT


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
        self.assertEqual(env.observation().shape,(4,64,80))
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

    def test_circles_at_every_field_corner_have_visible_complete_bodies(self):
        counts=[]
        for x,y in [(0,0),(512,0),(0,384),(512,384)]:
            env=self.single('circle');obj=env.objects[0]
            obj.update(x=x,y=y);env.radius=54.4;env.time=obj['time']
            image=env.render()
            counts.append(int(np.count_nonzero(image==65)))
            self.assertTrue(np.all(image[0,:]==8));self.assertTrue(np.all(image[-1,:]==8))
            self.assertTrue(np.all(image[:,0]==8));self.assertTrue(np.all(image[:,-1]==8))
        # The key indicators can overlap the lower-left circle; all four
        # bodies must still fit inside the image, with background beyond them.
        self.assertTrue(all(count>50 for count in counts))

    def test_visible_image_extends_beyond_field_without_reducing_resolution(self):
        env=self.single('circle');view=env.scene()['observation_view']
        self.assertEqual(view['scale'],1/8)
        self.assertEqual(view['world_left'],-64)
        self.assertEqual(view['world_top'],-64)
        self.assertEqual(view['world_width'],640)
        self.assertEqual(view['world_height'],512)

    def test_scene_snapshot_does_not_mutate_when_inputs_are_applied(self):
        env=self.single('circle');scene=env.scene();env.time=env.objects[0]['time']
        env.step((aim(env.objects[0]['x'],env.objects[0]['y']),1))
        self.assertIsNone(scene['objects'][0]['result']);self.assertEqual(env.events[0]['id'],0)

    def test_complete_training_maps_do_not_overlap_withheld_maps(self):
        with tempfile.TemporaryDirectory() as directory:
            maps=real_maps()
            for beatmap in maps:atomic_json(Path(directory)/(beatmap['source_sha256']+'.json'),beatmap)
            library=MapLibrary(directory)
            training={(map['source_sha256'],i) for map,start,end in library.training for i in range(start,end)}
            testing={(map['source_sha256'],i) for map,start,end in library.testing for i in range(start,end)}
            self.assertTrue(training);self.assertTrue(testing);self.assertFalse(training&testing)
            self.assertEqual(len(training|testing),sum(len(beatmap['objects']) for beatmap in maps))
            for beatmap,start,end in library.training:
                self.assertEqual(start,0);self.assertEqual(end,len(beatmap['objects']))

    def test_single_map_trains_every_object_and_reports_no_independent_test(self):
        with tempfile.TemporaryDirectory() as directory:
            atomic_json(Path(directory)/'real.json',self.map);library=MapLibrary(directory)
            self.assertEqual([(start,end) for _,start,end in library.training],[(0,len(self.map['objects']))])
            self.assertFalse(library.testing);self.assertIn('no independent test',library.split)

    def test_missed_complete_map_advances_without_an_accuracy_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            for beatmap in real_maps():atomic_json(Path(directory)/(beatmap['source_sha256']+'.json'),beatmap)
            library=MapLibrary(directory);env=Environment(library=library)
            first=env.beatmap['id'];expected=library.training[1][0]['id']
            done=False;frames=0
            while not done:
                _,_,done=env.step((aim(0,0),0));frames+=1
            self.assertGreater(frames,600)
            self.assertEqual(env.summary()['judged'],len(env.beatmap['objects']))
            self.assertEqual(env.summary()['accuracy'],0)
            env.reset();self.assertEqual(env.beatmap['id'],expected);self.assertNotEqual(first,expected)

    def test_saved_run_restores_pixels_and_future_judgments_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            atomic_json(Path(directory)/'real.json',self.map);library=MapLibrary(directory)
            env=Environment(library=library)
            for _ in range(1500):env.step((aim(256,192),0))
            self.assertGreater(env.time,20000)
            resumed=Environment(library=library);resumed.restore_run(env.save_run())
            self.assertEqual(env.progress(),resumed.progress());self.assertEqual(env.summary(),resumed.summary())
            np.testing.assert_array_equal(env.observation(),resumed.observation())
            for _ in range(120):
                left=env.step((aim(256,192),1));right=resumed.step((aim(256,192),1))
                np.testing.assert_array_equal(left[0],right[0]);self.assertEqual(left[1:],right[1:])
            self.assertEqual(env.summary(),resumed.summary())

class ParserTests(unittest.TestCase):
    def test_wrong_mode_and_nonfinite_values_are_rejected(self):
        with self.assertRaises(ValueError):parse_beatmap('osu file format v14\n[General]\nMode:3')
        with self.assertRaises(ValueError):parse_beatmap('osu file format v14\n[Difficulty]\nCircleSize:nan')

if __name__=='__main__':unittest.main()
