"""Native rule regressions on authored maps; no generated maps or training data."""
import copy
from pathlib import Path
import math
import unittest
import numpy as np
from _maps import real_map,real_maps
from rival.environment import Environment,FRAME_MS
from rival.beatmaps import slider_position
from rival.rules import hit_windows,update_tracking,report_spinner_delta,spinner_result,TAIL_LENIENCY


def aim(x,y):return np.arctanh(np.clip(np.array([x/256-1,y/192-1]),-.999999,.999999))


class LazerRulesTests(unittest.TestCase):
    def slider(self):
        beatmap=copy.deepcopy(real_map())
        beatmap['objects']=[next(obj for obj in beatmap['objects'] if obj['kind']=='slider')]
        return Environment(beatmap=beatmap)

    def follow(self,env):
        obj=env.objects[0]
        while obj['result'] is None:env.step((aim(*slider_position(obj,env.time+FRAME_MS)),1))

    def start(self,env,error=0):
        obj=env.objects[0];env.time=obj['time']+error
        env.step((aim(obj['x'],obj['y']),1))
        return obj

    def test_native_input_order_misses_skipped_heads_after_their_start(self):
        pair=None;beatmap=None
        for candidate in real_maps():
            circles=[o for o in candidate['objects'] if o['kind']=='circle']
            radius=54.4-4.48*candidate['cs']
            for first,second in zip(circles,circles[1:]):
                if 0<second['time']-first['time']<350 and math.dist((first['x'],first['y']),(second['x'],second['y']))>2*radius:
                    pair=[first,second];beatmap=copy.deepcopy(candidate);break
            if pair:break
        self.assertIsNotNone(pair,'Actual fixtures must contain a separated circle pair')
        beatmap['objects']=copy.deepcopy(pair);env=Environment(beatmap=beatmap)
        first,second=env.objects;target=aim(second['x'],second['y'])
        env.time=first['time']-1;env.activate();env.step((target,1))
        self.assertIsNone(first['result']);self.assertIsNone(second['result'])
        env.keys=0;env.time=first['time']+1;env.step((target,1))
        self.assertEqual(first['result'],0);self.assertIsNotNone(second['result'])

    def test_cache_upgrade_preserves_original_source_and_keeps_old_decode(self):
        import os,tempfile,json
        from rival.beatmaps import parse_beatmap,upgrade_cached_maps,MapLibrary
        from rival.storage import atomic_json
        text=Path(os.environ['RIVAL_TEST_MAP']).read_bytes().decode('utf-8').replace('\r\n','\n').replace('\n','\r\n')
        decoded=parse_beatmap(text);old=copy.deepcopy(decoded);old.pop('decoder_revision')
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);maps=root/'maps';maps.mkdir();identity=decoded['source_sha256'][:24]
            atomic_json(maps/(identity+'.json'),old);(maps/(identity+'.osu')).write_text(text)
            self.assertEqual(upgrade_cached_maps(maps),1)
            self.assertEqual(upgrade_cached_maps(maps),0)
            self.assertEqual((maps/(identity+'.osu')).read_bytes().decode('utf-8'),text)
            self.assertEqual(json.loads((root/'maps-before-lazer'/(identity+'.json')).read_text()),old)
            self.assertEqual(MapLibrary(maps).maps[0]['source_sha256'],decoded['source_sha256'])

    def test_legacy_run_upgrade_retains_playhead_and_excludes_unknown_past_scores(self):
        import tempfile
        from rival.beatmaps import MapLibrary
        from rival.storage import atomic_json
        beatmap=real_map()
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);identity=beatmap['source_sha256'][:24];atomic_json(root/(identity+'.json'),beatmap)
            library=MapLibrary(root);env=Environment(library=library)
            for _ in range(128):env.step((aim(100,100),0))
            saved=env.save_run();saved.pop('scoring_revision');saved.pop('scoring')
            legacy={'result','head','checkpoint_index','components_hit','rotation','last_angle'}
            saved['objects']=[{k:v for k,v in obj.items() if k in legacy} for obj in saved['objects']]
            resumed=Environment(library=library);resumed.restore_run(saved)
            self.assertEqual(resumed.time,env.time);self.assertEqual(resumed.cursor,env.cursor)
            self.assertEqual(resumed.scoring_scope,'new judgments after rules upgrade')
            self.assertEqual(resumed.accuracy_max,0)

    def test_native_hit_windows_include_half_millisecond_rounding(self):
        self.assertEqual(hit_windows(5),(49.5,99.5,149.5))
        self.assertEqual(hit_windows(8.1),(30.5,74.5,118.5))

    def test_late_head_remains_100_even_with_all_parts_collected(self):
        env=self.slider();obj=self.start(env,(env.windows[0]+env.windows[1])/2)
        self.follow(env)
        self.assertEqual(obj['head'],100)
        self.assertEqual(env.accuracy_max-env.accuracy_points,200)
        self.assertLess(env.summary()['accuracy'],1)
        self.assertEqual(env.summary()['max_combo'],1+len(obj['checkpoints']))
        self.assertEqual(env.summary()['slider_tracking_hit_rate'],1)

    def test_tracking_must_catch_ball_before_using_larger_follow_area(self):
        env=self.slider();obj=env.objects[0];time=obj['time']+obj['span']/2
        x,y=slider_position(obj,time);r=env.radius
        self.assertFalse(update_tracking(obj,(x+1.5*r,y),1,0,r,time))
        self.assertTrue(update_tracking(obj,(x+.5*r,y),1,1,r,time))
        self.assertTrue(update_tracking(obj,(x+2*r,y),1,1,r,time))
        self.assertFalse(update_tracking(obj,(x+3*r,y),1,1,r,time))
        self.assertFalse(update_tracking(obj,(x+2*r,y),1,1,r,time))
        self.assertTrue(update_tracking(obj,(x,y),1,1,r,time))

    def test_release_loses_tracking_and_preheld_other_key_cannot_replace_head_key(self):
        env=self.slider();obj=env.objects[0];time=obj['time'];target=slider_position(obj,time)
        obj.update(head_key=1,accept_any_key=False)
        self.assertFalse(update_tracking(obj,target,2,3,env.radius,time))
        self.assertTrue(update_tracking(obj,target,3,3,env.radius,time))
        self.assertFalse(update_tracking(obj,target,0,3,env.radius,time))
        self.assertTrue(update_tracking(obj,target,2,1,env.radius,time))
        self.assertTrue(obj['accept_any_key'])

    def test_releasing_before_tail_leniency_misses_tail_without_breaking_combo(self):
        env=self.slider();obj=self.start(env)
        while env.time+FRAME_MS<obj['end_time']-TAIL_LENIENCY:
            env.step((aim(*slider_position(obj,env.time+FRAME_MS)),1))
        combo=env.combo
        while obj['result'] is None:env.step((aim(0,0),0))
        self.assertEqual(obj['tail_result'],0)
        self.assertEqual(env.combo,combo)
        self.assertEqual(env.accuracy_max-env.accuracy_points,150)

    def test_tail_can_be_collected_in_last_36ms_then_released(self):
        env=self.slider();obj=self.start(env)
        while obj['tail_result'] is None:
            env.step((aim(*slider_position(obj,env.time+FRAME_MS)),1))
        self.assertLessEqual(obj['end_time']-env.time,36)
        while obj['result'] is None:env.step((aim(0,0),0))
        self.assertEqual(obj['tail_result'],150)
        self.assertEqual(env.summary()['accuracy'],1)
        self.assertEqual(env.max_combo,1+len(obj['checkpoints']))

    def test_reverse_span_ticks_use_same_path_positions_in_reverse_order(self):
        checked=0
        for beatmap in real_maps():
            for obj in beatmap['objects']:
                if obj['kind']!='slider' or obj['repeats']<2:continue
                spans=[]
                for span in (0,1):
                    times=[t for t,kind in zip(obj['checkpoints'],obj['checkpoint_kinds']) if kind=='tick' and obj['time']+span*obj['span']<t<obj['time']+(span+1)*obj['span']]
                    spans.append([slider_position(obj,t) for t in times])
                if not spans[0]:continue
                np.testing.assert_allclose(spans[0],list(reversed(spans[1])),atol=1e-7)
                checked+=1
        self.assertGreater(checked,0)

    def test_native_spinner_history_vectors_reject_direction_change_cheese(self):
        # From ppy/osu SpinnerSpinHistoryTest.TestSpinChangeDirection.
        for deltas,expected in [([10,-10,0],10),([10,-20,0],10),([20,-10,0],20),([10,-360,0],350),([360,-10,0],370),([10,10,-10],20)]:
            obj={'spin_accumulated':0.,'spin_completed_at':0.,'spin_max':0.,'spin_count':0,'rotation':0.}
            for degrees in deltas:report_spinner_delta(obj,math.radians(degrees))
            self.assertAlmostEqual(math.degrees(obj['rotation']),expected)

    def test_spinner_requirements_use_integer_lazer_spins(self):
        obj={'time':0,'end_time':2000,'rotation':2*math.pi*5}
        self.assertEqual(spinner_result(obj,5),300)
        obj['rotation']=2*math.pi*4.6;self.assertEqual(spinner_result(obj,5),100)
        obj['rotation']=2*math.pi*4;self.assertEqual(spinner_result(obj,5),50)
        obj['rotation']=0;obj['end_time']=100;self.assertEqual(spinner_result(obj,5),300)
