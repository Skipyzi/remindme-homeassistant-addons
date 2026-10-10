"""Measure learning on supplied real maps and a copied model.

Does not install experimental weights into the app's model library.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np
from rival.beatmaps import MapLibrary
from rival.parallel import Trainer
from rival.policy import Policy,evaluate


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--maps',required=True)
    parser.add_argument('--checkpoint',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--updates',type=int,default=200)
    parser.add_argument('--processes',type=int,default=4)
    parser.add_argument('--environments',type=int,default=8)
    parser.add_argument('--rollout-steps',type=int,default=128)
    parser.add_argument('--seed',type=int,default=321)
    parser.add_argument('--optimizer-seed',type=int,default=123)
    args=parser.parse_args()
    if min(args.updates,args.processes,args.environments,args.rollout_steps)<1:parser.error('Counts must be positive')
    if args.processes>args.environments:parser.error('Processes cannot exceed environments')
    library=MapLibrary(args.maps)
    if not library.testing:parser.error('Independent withheld maps or sections are required')
    checkpoint=Path(args.checkpoint).read_bytes()
    policy,metadata=Policy.load(checkpoint)
    if metadata.get('training_format')!='real-beatmap-v1':parser.error('Use a real-beatmap checkpoint')
    sections=library.evaluation_sections(12);seeds=(91000,91011,91022)
    trainer=Trainer(policy,library,Path(args.maps),args.environments,args.processes,args.seed)
    rng=np.random.default_rng(args.optimizer_seed);started=time.monotonic();history=[]
    totals={key:0 for key in ('score_reward','score_events','steps')}
    try:
        for index in range(1,args.updates+1):
            stats=trainer.update(rng,steps=args.rollout_steps)
            for key in totals:totals[key]+=stats[key]
            if index%25==0:print(f'Update {index}/{args.updates}',flush=True)
            if index==100 or index==args.updates:
                results=[evaluate(policy,sections,seed=seed) for seed in seeds]
                history.append({'update':index,'accuracy':float(np.mean([r['accuracy'] for r in results])),
                                'hit_rate':float(np.mean([r['hit_rate'] for r in results])),'results':results})
    finally:trainer.close()
    report={'source':'real-beatmaps','settings':vars(args),
            'checkpoint_sha256':hashlib.sha256(checkpoint).hexdigest(),
            'map_hashes':[beatmap['source_sha256'] for beatmap in library.maps],
            'elapsed_seconds':time.monotonic()-started,'history':history,'totals':totals,
            'std':np.exp(policy.parameters['logstd']).tolist(),
            'limits':'One training seed. Raw practice judgments; not native multiplayer scoring.'}
    Path(args.output).write_text(json.dumps(report,indent=2)+'\n')


if __name__=='__main__':main()
