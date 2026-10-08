import os
from pathlib import Path
import unittest
from rival.beatmaps import parse_beatmap


def real_map():
    path=os.environ.get('RIVAL_TEST_MAP')
    if not path or not Path(path).is_file():
        raise unittest.SkipTest('Set RIVAL_TEST_MAP to an actual .osu beatmap for gameplay/learning checks')
    return parse_beatmap(Path(path).read_text(encoding='utf-8-sig'))


def real_maps():
    path=os.environ.get('RIVAL_TEST_MAP')
    if not path:raise unittest.SkipTest('Provide actual beatmap fixtures')
    maps=[parse_beatmap(file.read_text(encoding='utf-8-sig')) for file in sorted(Path(path).parent.glob('*.osu'))]
    if len(maps)<2:raise unittest.SkipTest('At least two actual beatmaps are required')
    return maps
