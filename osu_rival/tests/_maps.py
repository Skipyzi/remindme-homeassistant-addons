import os
from pathlib import Path
import unittest
from rival.beatmaps import parse_beatmap


def real_map():
    path=os.environ.get('RIVAL_TEST_MAP')
    if not path or not Path(path).is_file():
        raise unittest.SkipTest('Set RIVAL_TEST_MAP to an actual .osu beatmap for gameplay/learning checks')
    return parse_beatmap(Path(path).read_text(encoding='utf-8-sig'))
