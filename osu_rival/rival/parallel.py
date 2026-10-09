"""Training on many cores: several environments and processes learning together, with the same PPO as policy.py.

`policy.update()` plays one environment and learns in one thread. Here the work is split into shards. Each shard
owns a few environments and its own copy of the network, whose weights live in shared memory, so every process
always acts with the current weights without copying them. An update has two phases:

1. All shards play `steps` frames of each of their environments at the same time and compute advantages locally.
2. PPO epochs: for every minibatch, each shard computes the gradient on its own share of the minibatch, the main
   process adds the shards' gradients up and takes one optimizer step, and the new weights are in shared memory
   for the next minibatch.

Shard 0 runs in the main process and owns environment 0, the one shown live and saved for resuming. Each
environment plays its own complete training maps: environment k starts on map k and then takes every n-th map.
"""
import math
import multiprocessing as mp
from multiprocessing import shared_memory
import os

import numpy as np

from .beatmaps import MapLibrary
from .environment import Environment
from .policy import SHAPES, Policy, advantages_and_returns

PARAMETERS = [(name, shape, math.prod(shape)) for name, shape in SHAPES.items()]
PARAMETER_SIZE = sum(size for _, _, size in PARAMETERS)


def bind(policy, buffer):
    """Make the policy's weights views into a flat float32 buffer (shared memory); the buffer's values are kept."""
    flat = np.ndarray((PARAMETER_SIZE,), np.float32, buffer=buffer)
    offset = 0
    for name, shape, size in PARAMETERS:
        policy.parameters[name] = flat[offset:offset + size].reshape(shape)
        offset += size
    return flat


def flatten(arrays, out):
    offset = 0
    for name, _, size in PARAMETERS:
        out[offset:offset + size] = arrays[name].ravel()
        offset += size


def unflatten(flat):
    result, offset = {}, 0
    for name, shape, size in PARAMETERS:
        result[name] = flat[offset:offset + size].reshape(shape)
        offset += size
    return result


def sample_batch(policy, observations, rng):
    """Actions for a batch of observations: latents (n, 2), keys (n,), log-probabilities (n,), values (n,)."""
    means, probabilities, values = policy.forward(observations)
    latents = (means + np.exp(policy.parameters['logstd']) * rng.normal(size=means.shape)).astype(np.float32)
    cumulative = np.cumsum(probabilities.astype(np.float64), axis=1)
    cumulative /= cumulative[:, -1:]
    keys = np.minimum((rng.random(len(means))[:, None] > cumulative).sum(axis=1), 3).astype(np.int64)
    logp = policy.log_probabilities(means, probabilities, latents, keys)
    return latents, keys, logp.astype(np.float32), values.astype(np.float32)


class Shard:
    """Some environments, a network bound to the shared weights, and the experience they collected."""
    def __init__(self, library, indices, count, seed, buffer, slot, first=None, map_offset=0, reward_feedback=False):
        self.indices=list(indices)
        self.envs = [first if (i == 0 and first is not None) else Environment(seed=seed + i, library=library, map_index=map_offset+i, map_stride=count,reward_feedback=reward_feedback)
                     for i in indices]
        for env in self.envs:
            env.reward_feedback=reward_feedback
            if env.map_stride != count and env.library:
                current=next(index for index,(beatmap,_,_) in enumerate(library.training) if beatmap['id']==env.beatmap['id'])
                env.next_map_index=current+count
            env.map_stride = count
        self.policy = Policy(seed)
        self.weights = bind(self.policy, buffer)
        self.slot = slot   # this shard's gradient output, a row of the shared gradient buffer
        self.rng = np.random.default_rng(seed * 7919 + (indices[0] if indices else 0))
        self.data = None

    def rollout(self, steps, progress=None, interrupt=None):
        n = len(self.envs)
        current = np.stack([env.observation() for env in self.envs])
        observations = np.empty((steps, n) + current.shape[1:], np.uint8)
        latents = np.empty((steps, n, 2), np.float32); keys = np.empty((steps, n), np.int64)
        logps = np.empty((steps, n), np.float32); values = np.empty((steps, n), np.float32)
        rewards = np.empty((steps, n), np.float32); dones = np.empty((steps, n), bool)
        finished = []
        score_reward=feedback_reward=0.0;score_events=feedback_events=0
        for step in range(steps):
            if interrupt and interrupt():
                return None
            latent, key, logp, value = sample_batch(self.policy, current, self.rng)
            observations[step], latents[step], keys[step], logps[step], values[step] = current, latent, key, logp, value
            following = []
            for index, env in enumerate(self.envs):
                observation, reward, done = env.step((latent[index], int(key[index])))
                score_reward+=env.last_reward['score'];feedback_reward+=env.last_reward['feedback']
                score_events+=int(env.last_reward['score']!=0);feedback_events+=int(abs(env.last_reward['feedback'])>1e-8)
                if done:
                    finished.append(env.summary())
                    observation = env.reset()
                following.append(observation); rewards[step, index] = reward; dones[step, index] = done
            current = np.stack(following)
            if progress:
                progress(self.envs[0], step)
        bootstrap = self.policy.forward(current)[2]
        advantages = np.empty_like(rewards); returns = np.empty_like(rewards)
        for index in range(n):
            advantages[:, index], returns[:, index] = advantages_and_returns(rewards[:, index], values[:, index], dones[:, index], float(bootstrap[index]))
        total = steps * n
        flat = lambda array: array.reshape((total,) + array.shape[2:])
        self.data = [flat(observations), flat(latents), flat(keys), flat(logps)]
        self.advantages, self.returns = flat(advantages), flat(returns)
        self.order, self.cursor = None, 0
        adv = self.advantages.astype(np.float64)
        return {'count': total, 'sum': float(adv.sum()), 'squares': float((adv ** 2).sum()), 'reward': float(rewards.sum()), 'episodes': finished,
                'score_reward':score_reward,'feedback_reward':feedback_reward,'score_events':score_events,'feedback_events':feedback_events}

    def snapshot(self):
        return {'indices':self.indices,'runs':[env.save_run() for env in self.envs],'rng':self.rng.bit_generator.state}

    def scenes(self):
        return [{'index':index,'scene':env.scene(visible_only=True)} for index,env in zip(self.indices,self.envs)]

    def restore(self, saved):
        if saved.get('indices') != self.indices or len(saved.get('runs',[])) != len(self.envs):
            raise ValueError('Saved parallel layout differs from this trainer')
        for env,run in zip(self.envs,saved['runs']):env.restore_run(run)
        self.rng.bit_generator.state=saved['rng']

    def normalize(self, mean, std):
        self.normalized = ((self.advantages - mean) / std).astype(np.float32)

    def observations(self):
        return np.stack([env.observation() for env in self.envs])

    def rng_state(self):
        return self.rng.bit_generator.state

    def set_rng(self, state):
        self.rng.bit_generator.state = state

    def play(self, latents, keys):
        observations, rewards, dones, episodes = [], [], [], []
        stats = dict.fromkeys(['score_reward','feedback_reward','score_events','feedback_events'], 0)
        for env, latent, key in zip(self.envs, latents, keys):
            observation, reward, done = env.step((latent, int(key)))
            stats['score_reward'] += env.last_reward['score']; stats['feedback_reward'] += env.last_reward['feedback']
            stats['score_events'] += int(env.last_reward['score'] != 0)
            stats['feedback_events'] += int(abs(env.last_reward['feedback']) > 1e-8)
            if done:
                episodes.append(env.summary()); observation = env.reset()
            observations.append(observation); rewards.append(reward); dones.append(done)
        return np.stack(observations), rewards, dones, episodes, stats

    def epoch(self):
        self.order, self.cursor = self.rng.permutation(len(self.normalized)), 0

    def gradient(self, size):
        """Gradient summed over this shard's next `size` samples (the policy's loss is a mean, so scale it back)."""
        chosen = self.order[self.cursor:self.cursor + size]
        self.cursor += size
        if not len(chosen):
            return 0, None
        metrics, gradients = self.policy.loss_and_gradients(*(value[chosen] for value in self.data), self.normalized[chosen], self.returns[chosen])
        n = len(chosen)
        flatten(gradients, self.slot)
        self.slot *= n
        return n, {key: value * n for key, value in metrics.items()}


def _serve(connection, name, gradient_name, row, maps_directory, indices, count, seed, map_offset,reward_feedback):
    """Worker process: one shard, driven by the main process over a pipe."""
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    memory, gradient_memory = shared_memory.SharedMemory(name=name), shared_memory.SharedMemory(name=gradient_name)
    shard = None
    try:
        slot = np.ndarray((PARAMETER_SIZE,), np.float32, buffer=gradient_memory.buf, offset=row * PARAMETER_SIZE * 4)
        shard = Shard(MapLibrary(maps_directory), indices, count, seed, memory.buf, slot, map_offset=map_offset,reward_feedback=reward_feedback)
        connection.send('ready')
        while True:
            command, *args = connection.recv()
            if command == 'rollout':
                connection.send(shard.rollout(*args))
            elif command == 'normalize':
                shard.normalize(*args); connection.send(None)
            elif command == 'epoch':
                shard.epoch(); connection.send(None)
            elif command in ('observations', 'rng_state', 'set_rng', 'play'):
                connection.send(getattr(shard, command)(*args))
            elif command == 'gradient':
                connection.send(shard.gradient(*args))
            elif command == 'snapshot':
                connection.send(shard.snapshot())
            elif command == 'scenes':
                connection.send(shard.scenes())
            elif command == 'restore':
                shard.restore(*args); connection.send(None)
            elif command == 'close':
                return
    finally:
        shard = slot = None
        memory.close(); gradient_memory.close()


class Trainer:
    """Parallel PPO over `count` environments in `processes` processes (the main process is one of them)."""
    def __init__(self, policy, library, maps_directory, count, processes, seed, first=None,reward_feedback=False, device='cpu'):
        self.policy, self.count = policy, count
        self.device, self.waiting = device, {}
        processes = max(1, min(processes, count))
        groups = [list(range(count))[i::processes] for i in range(processes)]
        self.memory = shared_memory.SharedMemory(create=True, size=PARAMETER_SIZE * 4)
        self.weights = np.ndarray((PARAMETER_SIZE,), np.float32, buffer=self.memory.buf)
        self.gradient_memory = shared_memory.SharedMemory(create=True, size=processes * PARAMETER_SIZE * 4)
        self.gradients = np.ndarray((processes, PARAMETER_SIZE), np.float32, buffer=self.gradient_memory.buf)
        self.publish()
        offset=next((index for index,(beatmap,_,_) in enumerate(library.training) if first is not None and beatmap['id']==first.beatmap['id']),0)
        self.local = Shard(library, groups[0], count, seed, self.memory.buf, self.gradients[0], first=first,map_offset=offset,reward_feedback=reward_feedback)
        context = mp.get_context('spawn')
        self.workers = []
        for row, group in enumerate(groups[1:], 1):
            parent, child = context.Pipe()
            process = context.Process(target=_serve, args=(child, self.memory.name, self.gradient_memory.name, row, str(maps_directory), group, count, seed, offset,reward_feedback), daemon=True)
            process.start(); child.close()
            self.workers.append((process, parent))
        for _, parent in self.workers:
            parent.recv()
        self.publish()

    @property
    def shown(self):
        return self.local.envs[0]

    def publish(self):
        offset = 0
        for name, _, size in PARAMETERS:
            self.weights[offset:offset + size] = self.policy.parameters[name].ravel()
            offset += size

    def _all(self, command, *args, local=None):
        for _, parent in self.workers:
            parent.send((command, *args))
        try:
            mine = local() if local else getattr(self.local, command)(*args)
        except BaseException:
            # Drain replies before a pause saves runs or issues another command.
            # Otherwise snapshot() reads the abandoned rollout results as saved runs.
            for _,parent in self.workers:parent.recv()
            raise
        return [mine] + [parent.recv() for _, parent in self.workers]

    def scenes(self):
        return sorted([run for shard in self._all('scenes') for run in shard],key=lambda run:run['index'])

    def snapshot(self):
        saved = {'count':self.count,'shards':self._all('snapshot')}
        if self.waiting: saved['waiting'] = self.waiting
        return saved

    def restore(self, saved):
        shards=saved.get('shards',[])
        groups = [list(range(self.count))[index::len(self.workers)+1] for index in range(len(self.workers)+1)]
        if saved.get('count') != self.count or [part.get('indices') for part in shards] != groups:
            runs = {int(index): run for index, run in saved.get('waiting', {}).items()}
            for part in shards:
                if len(part.get('indices', [])) != len(part.get('runs', [])):
                    raise ValueError('Invalid saved parallel runs')
                runs.update(zip(part['indices'], part['runs']))
            current = self._all('snapshot')
            shards = []
            for group, part in zip(groups, current):
                restored = []
                for index, fresh in zip(group, part['runs']):
                    run = runs.pop(index, fresh).copy()
                    # Keep this map's position; future maps use the new stride.
                    restored.append(run)
                shards.append({**part, 'runs': restored})
            self.waiting = {str(index): run for index, run in runs.items()}
        else:
            self.waiting = saved.get('waiting', {}).copy()
        # Validate the entire snapshot before sending any commands to the children.
        for part in shards:
            candidate=Shard.__new__(Shard)
            candidate.indices=part['indices'];candidate.rng=np.random.default_rng()
            candidate.envs=[Environment(library=self.local.envs[0].library,map_stride=self.count) for _ in part['indices']]
            candidate.restore(part)
        for (_,parent),part in zip(self.workers,shards[1:]):parent.send(('restore',part))
        self.local.restore(shards[0])
        for _,parent in self.workers:parent.recv()
        return True

    def update(self, rng, steps=128, epochs=4, minibatch=256, progress=None, interrupt=None, views=None):
        self.publish()
        if self.device == 'gpu':
            return self.gpu_update(rng, steps, epochs, minibatch, progress, interrupt, views)
        results = self._all('rollout', steps, local=lambda: self.local.rollout(steps, progress, interrupt))
        if views:views(self.scenes())
        if results[0] is None:
            for result in results[1:]:
                pass
            return None
        total = sum(r['count'] for r in results)
        mean = sum(r['sum'] for r in results) / total
        std = max(math.sqrt(max(sum(r['squares'] for r in results) / total - mean ** 2, 0)), 1e-6)
        self._all('normalize', mean, std)
        shares = [r['count'] / total for r in results]
        minibatch = max(32, min(minibatch, total))
        stats = []
        for _ in range(epochs):
            if interrupt and interrupt():
                return None
            self._all('epoch')
            for _ in range(math.ceil(total / minibatch)):
                if interrupt and interrupt():
                    return None
                sizes = [max(1, round(minibatch * share)) for share in shares]
                parts = [None] * len(sizes)
                for (_, parent), size in zip(self.workers, sizes[1:]):
                    parent.send(('gradient', size))
                parts[0] = self.local.gradient(sizes[0])
                for index, (_, parent) in enumerate(self.workers, 1):
                    parts[index] = parent.recv()
                n = sum(part[0] for part in parts)
                if not n:
                    break
                used = [index for index, part in enumerate(parts) if part[0]]
                gradients = unflatten(self.gradients[used].sum(axis=0) / n)
                metrics = {key: sum(parts[index][1][key] for index in used) / n for key in parts[used[0]][1]}
                self.policy.optimize(gradients)
                self.publish()
                stats.append(metrics)
            if np.mean([item['approx_kl'] for item in stats[-math.ceil(total / minibatch):]]) > .03:
                break
        return self.result(results, total, stats)

    def gpu_update(self, rng, steps, epochs, minibatch, progress, interrupt, views):
        """Batch every run's visual inference on one GPU; CPU shards advance real maps.

        CPU shards keep their action RNGs and playheads when switching devices.
        Replies are collected before callbacks so a pause cannot corrupt IPC.
        """
        from .accelerator import Optimizer
        optimizer = Optimizer(self.policy)
        t = optimizer.torch
        current = np.concatenate(self._all('observations'))
        states = self._all('rng_state')
        streams = [np.random.default_rng() for _ in states]
        for stream, state in zip(streams, states): stream.bit_generator.state = state
        sizes = [len(self.local.envs)] + [len(range(i, self.count, len(states))) for i in range(1, len(states))]
        offsets = np.cumsum([0, *sizes])
        observations = np.empty((steps, self.count, *current.shape[1:]), np.uint8)
        latents = np.empty((steps, self.count, 2), np.float32)
        keys = np.empty((steps, self.count), np.int64)
        logps = np.empty((steps, self.count), np.float32)
        values = np.empty((steps, self.count), np.float32)
        rewards = np.empty_like(values); dones = np.empty_like(values, dtype=bool)
        episodes, totals = [], dict.fromkeys(['score_reward','feedback_reward','score_events','feedback_events'], 0)
        def inference(pixels):
            with t.no_grad():
                means, probabilities, value = optimizer.forward(t.as_tensor(pixels, device='cuda'))
                return t.cat([means, probabilities, value[:, None]], dim=1).cpu().numpy()
        try:
            for step in range(steps):
                if interrupt and interrupt(): return None
                output = inference(current)
                observations[step] = current
                means, probabilities = output[:, :2], output[:, 2:6]
                values[step] = output[:, 6]
                for start, end, stream in zip(offsets[:-1], offsets[1:], streams):
                    latent = (means[start:end] + np.exp(self.policy.parameters['logstd']) * stream.normal(size=(end-start, 2))).astype(np.float32)
                    cumulative = np.cumsum(probabilities[start:end].astype(np.float64), axis=1)
                    cumulative /= cumulative[:, -1:]
                    key = np.minimum((stream.random(end-start)[:, None] > cumulative).sum(1), 3).astype(np.int64)
                    latents[step, start:end], keys[step, start:end] = latent, key
                logps[step] = self.policy.log_probabilities(means, probabilities, latents[step], keys[step])
                for (_, parent), start, end in zip(self.workers, offsets[1:-1], offsets[2:]):
                    parent.send(('play', latents[step, start:end], keys[step, start:end]))
                # _all() cannot send different actions to each shard. Drain all
                # replies even if a local environment raises, like CPU rollout.
                try: local = self.local.play(latents[step, :sizes[0]], keys[step, :sizes[0]])
                except BaseException:
                    for _, parent in self.workers: parent.recv()
                    raise
                played = [local] + [parent.recv() for _, parent in self.workers]
                current = np.concatenate([part[0] for part in played])
                rewards[step] = np.concatenate([part[1] for part in played])
                dones[step] = np.concatenate([part[2] for part in played])
                for part in played:
                    episodes.extend(part[3])
                    for key in totals: totals[key] += part[4][key]
                if progress: progress(self.shown, step)
            bootstrap = inference(current)[:, 6]
            advantages, returns = np.empty_like(values), np.empty_like(values)
            for index in range(self.count):
                advantages[:, index], returns[:, index] = advantages_and_returns(rewards[:, index], values[:, index], dones[:, index], float(bootstrap[index]))
            flat = lambda a: a.reshape((steps*self.count, *a.shape[2:]))
            normalized = (advantages - advantages.mean(dtype=np.float64)) / max(float(advantages.std(dtype=np.float64)), 1e-6)
            data = [flat(a) for a in [observations, latents, keys, logps, normalized.astype(np.float32), returns]]
            if views: views(self.scenes())
            stats = optimizer.update([data], rng, epochs, max(32, min(minibatch, steps*self.count)), interrupt)
            self.publish()
            if stats is None: return None
            result = {'episodes': episodes, 'reward': float(rewards.sum()), **totals}
            return self.result([result], steps*self.count, stats)
        finally:
            for (_, parent), stream in zip(self.workers, streams[1:]):
                parent.send(('set_rng', stream.bit_generator.state))
            self.local.set_rng(streams[0].bit_generator.state)
            for _, parent in self.workers: parent.recv()

    def result(self, results, total, stats):
        episodes = [episode for r in results for episode in r['episodes']]
        metrics = {key: float(np.mean([stat[key] for stat in stats])) for key in stats[0]}
        return {'steps': total, 'episodes': episodes, 'reward': float(sum(r['reward'] for r in results)),
                'environments': self.count, 'processes': len(self.workers) + 1,
                **{key:sum(r[key] for r in results) for key in ['score_reward','feedback_reward','score_events','feedback_events']},**metrics}

    def close(self):
        for process, parent in self.workers:
            try:
                parent.send(('close',))
            except (OSError, BrokenPipeError):
                pass
        for process, parent in self.workers:
            process.join(timeout=3)
            if process.is_alive():
                process.terminate();process.join(timeout=3)
            parent.close()
        self.workers = []
        self.local = self.weights = self.gradients = None
        for memory in (self.memory, self.gradient_memory):
            memory.close(); memory.unlink()
