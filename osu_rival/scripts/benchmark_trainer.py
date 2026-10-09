"""Compare complete CPU/GPU PPO updates on copies of a real-map checkpoint.

Run with PYTHONPATH=. python scripts/benchmark_trainer.py --maps /data/maps
--checkpoint /data/models/latest.npz --runs /data/models/latest-run.json.
Never writes to the input model or runs.
"""
import argparse
import json
import statistics
import time
from pathlib import Path
import numpy as np
from rival.accelerator import capabilities
from rival.beatmaps import MapLibrary
from rival.parallel import Trainer
from rival.policy import Policy


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--maps', required=True)
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--runs')
    parser.add_argument('--processes', type=int, default=4)
    parser.add_argument('--environments', type=int, default=8)
    parser.add_argument('--updates', type=int, default=5)
    args = parser.parse_args()
    if not 1 <= args.processes <= args.environments <= 64 or not 1 <= args.updates <= 100:
        parser.error('Use 1 to 64 runs, at least one per process, and 1 to 100 updates')
    library = MapLibrary(args.maps)
    saved = json.loads(Path(args.runs).read_text()).get('parallel') if args.runs else None
    gpu = capabilities()
    report = {'gpu': gpu, 'processes': args.processes, 'environments': args.environments, 'results': {}}
    trainers, policies, streams, times, initial = {}, {}, {}, {}, {}
    devices = ['cpu'] + (['gpu'] if gpu['available'] else [])
    try:
        for device in devices:
            policy, metadata = Policy.load(Path(args.checkpoint).read_bytes())
            policies[device], streams[device], times[device] = policy, np.random.default_rng(765123), []
            trainers[device] = Trainer(policy, library, args.maps, args.environments, args.processes, 765123, reward_feedback=True, device=device)
            if saved: trainers[device].restore(saved)
            initial[device] = policy.optimizer_step
        for index in range(args.updates+1):
            # Alternate order to reduce bias from changing desktop workloads.
            for device in devices if index % 2 == 0 else devices[::-1]:
                start = time.monotonic()
                result = trainers[device].update(streams[device])
                elapsed = time.monotonic()-start
                if index: times[device].append(elapsed)
        for device in devices:
            report['results'][device] = {'seconds': times[device], 'median_seconds': statistics.median(times[device]),
                                        'steps_per_second': result['steps']/statistics.median(times[device]),
                                        'optimizer_steps': policies[device].optimizer_step-initial[device]}
    finally:
        for trainer in trainers.values(): trainer.close()
    if 'gpu' in report['results']:
        report['speedup'] = report['results']['cpu']['median_seconds']/report['results']['gpu']['median_seconds']
    print(json.dumps(report, indent=2))


if __name__ == '__main__': main()
