"""Paired checks on real withheld maps, without training or replacing models."""
import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import time

import numpy as np

from rival.beatmaps import MapLibrary
from rival.environment import Environment
from rival.policy import Policy


def measure(policy, sections, seeds, blind=False):
    entries = [(Environment(section=section), np.random.default_rng(seed + index + 100000), index, seed)
               for seed in seeds for index, section in enumerate(sections)]
    active = entries.copy()
    iterations = 0
    while active:
        following = []
        for start in range(0, len(active), 8):
            batch = active[start:start + 8]
            observations = np.stack([env.observation() for env, _, _, _ in batch])
            if blind:
                # Preserve the trained output biases; remove all visual actor connections.
                actor = policy.parameters['ab']
                means = np.broadcast_to(actor[:2], (len(batch), 2))
                logits = actor[2:] - actor[2:].max()
                probabilities = np.broadcast_to(np.exp(logits) / np.exp(logits).sum(), (len(batch), 4))
            else:
                means, probabilities, _ = policy.forward(observations)
            for row, (env, rng, index, seed) in enumerate(batch):
                latent = (means[row] + np.exp(policy.parameters['logstd']) * rng.normal(size=2)).astype(np.float32)
                probs = probabilities[row].astype(np.float64)
                probs /= probs.sum()
                keys = int(rng.choice(4, p=probs))
                _, _, done = env.step((latent, keys))
                if not done:
                    following.append((env, rng, index, seed))
        active = following
        iterations += 1
        if iterations % 300 == 0:
            print(f'  Frame {iterations}: {len(active)} active sections', flush=True)
    return [{'section': index, 'seed': seed, 'map_id': sections[index][0]['id'], **env.summary()}
            for env, _, index, seed in entries]


def aggregate(results):
    points = sum(row['points'] for row in results)
    maximum = sum(row['accuracy_max'] for row in results)
    objects = sum(row['objects'] for row in results)
    parts = sum(row['slider_parts_total'] for row in results)
    return {'accuracy': points / maximum, 'hit_rate': sum(row['hits'] for row in results) / objects,
            'slider_tracking_hit_rate': sum(row['slider_parts_hit'] for row in results) / max(1, parts),
            'objects': objects, 'slider_parts_total': parts, 'points': points, 'accuracy_max': maximum}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('maps', 'current', 'initial', 'output'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--sections-per-map', type=int, default=2)
    parser.add_argument('--seed-count', type=int, default=5)
    args = parser.parse_args()
    if min(args.sections_per_map, args.seed_count) < 1:
        parser.error('Counts must be positive')
    library = MapLibrary(args.maps)
    chart = {(m['id'], start, end) for m, start, end in library.evaluation_sections(8)}
    groups = defaultdict(list)
    for section in library.testing:
        m, start, end = section
        if (m['id'], start, end) not in chart:
            groups[m['id']].append(section)
    if len(groups) < 2:
        parser.error('At least two independent withheld maps with additional sections are required')
    rng = np.random.default_rng(70361)
    sections = []
    for map_id in sorted(groups):
        choices = groups[map_id]
        indices = sorted(rng.choice(len(choices), min(args.sections_per_map, len(choices)), replace=False))
        sections.extend(choices[index] for index in indices)
    seeds = [204100 + 17 * index for index in range(args.seed_count)]
    current_data, initial_data = Path(args.current).read_bytes(), Path(args.initial).read_bytes()
    current, metadata = Policy.load(current_data)
    initial, _ = Policy.load(initial_data)
    reports = {}
    for name, policy, blind in [('initial', initial, False), ('current', current, False), ('bias_only_control', current, True)]:
        started = time.monotonic()
        print(f'{name}: {len(sections)} real sections on {len(groups)} withheld maps × {len(seeds)} seeds', flush=True)
        rows = measure(policy, sections, seeds, blind)
        reports[name] = {'summary': aggregate(rows), 'rows': rows, 'seconds': time.monotonic() - started}
        print(reports[name]['summary'], flush=True)
    ids = sorted(groups)
    per_map = {name: np.array([[sum(row['points'] for row in report['rows'] if row['map_id'] == map_id),
                               sum(row['accuracy_max'] for row in report['rows'] if row['map_id'] == map_id)] for map_id in ids])
               for name, report in reports.items()}
    draws = np.random.default_rng(407).integers(len(ids), size=(10000, len(ids)))
    comparisons = {}
    for name in ('initial', 'bias_only_control'):
        def ratios(values):
            sampled = values[draws].sum(axis=1)
            return sampled[:, 0] / sampled[:, 1]
        difference = ratios(per_map['current']) - ratios(per_map[name])
        comparisons[name] = {'accuracy_gain': reports['current']['summary']['accuracy'] - reports[name]['summary']['accuracy'],
                             'map_cluster_bootstrap_95_interval': np.percentile(difference, [2.5, 97.5]).tolist()}
    report = {'source': 'real authored beatmaps, unchanged rules and stochastic actions',
              'checkpoint': {key: metadata.get(key) for key in ('steps', 'updates', 'scoring_revision')},
              'sha256': {'current': hashlib.sha256(current_data).hexdigest(), 'initial': hashlib.sha256(initial_data).hexdigest()},
              'maps': len(groups), 'sections': [{'map_id': m['id'], 'source_sha256': m['source_sha256'], 'start': start, 'end': end} for m, start, end in sections],
              'excluded_chart_sections': True, 'seeds': seeds, 'reports': reports, 'comparisons': comparisons,
              'limits': 'One checkpoint, one real-map library. Confidence intervals resample whole maps with paired seeds. No native client comparison, training or model replacement.'}
    Path(args.output).write_text(json.dumps(report, indent=2) + '\n')
    print(comparisons, flush=True)


if __name__ == '__main__':
    main()
