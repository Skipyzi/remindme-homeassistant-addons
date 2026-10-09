"""Measure learning only on a supplied library of actual beatmap files."""
import argparse
import json
import time
import numpy as np
from rival.beatmaps import MapLibrary
from rival.environment import Environment
from rival.policy import Policy,evaluate,update

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--maps',required=True)
    parser.add_argument('--updates',type=int,default=20)
    args=parser.parse_args()
    library=MapLibrary(args.maps)
    model=Policy(42);rng=np.random.default_rng(42)
    env=Environment(library=library)
    sections=library.evaluation_sections()
    before=evaluate(model,sections)
    start=time.monotonic()
    for _ in range(args.updates):
        update(model,env,rng)
    print(json.dumps({'source':'real-beatmaps','map_hashes':[m['source_sha256'] for m in library.maps],
                     'updates':args.updates,'steps':args.updates*512,'elapsed_seconds':time.monotonic()-start,
                     'before':before,'after':evaluate(model,sections),'test_split':library.split,
                     'limits':'Local training judge; does not demonstrate native multiplayer ability.'},indent=2))

if __name__=='__main__':main()
