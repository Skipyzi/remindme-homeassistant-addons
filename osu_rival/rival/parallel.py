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
    def __init__(self, library, indices, count, seed, buffer, slot, first=None):
        self.envs = [first if (i == 0 and first is not None) else Environment(seed=seed + i, library=library, map_index=i, map_stride=count)
                     for i in indices]
        for env in self.envs:
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
        for step in range(steps):
            if interrupt and interrupt():
                return None
            latent, key, logp, value = sample_batch(self.policy, current, self.rng)
            observations[step], latents[step], keys[step], logps[step], values[step] = current, latent, key, logp, value
            following = []
            for index, env in enumerate(self.envs):
                observation, reward, done = env.step((latent[index], int(key[index])))
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
        return {'count': total, 'sum': float(adv.sum()), 'squares': float((adv ** 2).sum()), 'reward': float(rewards.sum()), 'episodes': finished}

    def normalize(self, mean, std):
        self.normalized = ((self.advantages - mean) / std).astype(np.float32)

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


def _serve(connection, name, gradient_name, row, maps_directory, indices, count, seed):
    """Worker process: one shard, driven by the main process over a pipe."""
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    memory, gradient_memory = shared_memory.SharedMemory(name=name), shared_memory.SharedMemory(name=gradient_name)
    shard = None
    try:
        slot = np.ndarray((PARAMETER_SIZE,), np.float32, buffer=gradient_memory.buf, offset=row * PARAMETER_SIZE * 4)
        shard = Shard(MapLibrary(maps_directory), indices, count, seed, memory.buf, slot)
        connection.send('ready')
        while True:
            command, *args = connection.recv()
            if command == 'rollout':
                connection.send(shard.rollout(*args))
            elif command == 'normalize':
                shard.normalize(*args); connection.send(None)
            elif command == 'epoch':
                shard.epoch(); connection.send(None)
            elif command == 'gradient':
                connection.send(shard.gradient(*args))
            elif command == 'close':
                return
    finally:
        shard = slot = None
        memory.close(); gradient_memory.close()


class Trainer:
    """Parallel PPO over `count` environments in `processes` processes (the main process is one of them)."""
    def __init__(self, policy, library, maps_directory, count, processes, seed, first=None):
        self.policy, self.count = policy, count
        processes = max(1, min(processes, count))
        groups = [list(range(count))[i::processes] for i in range(processes)]
        self.memory = shared_memory.SharedMemory(create=True, size=PARAMETER_SIZE * 4)
        self.weights = np.ndarray((PARAMETER_SIZE,), np.float32, buffer=self.memory.buf)
        self.gradient_memory = shared_memory.SharedMemory(create=True, size=processes * PARAMETER_SIZE * 4)
        self.gradients = np.ndarray((processes, PARAMETER_SIZE), np.float32, buffer=self.gradient_memory.buf)
        self.publish()
        self.local = Shard(library, groups[0], count, seed, self.memory.buf, self.gradients[0], first=first)
        context = mp.get_context('spawn')
        self.workers = []
        for row, group in enumerate(groups[1:], 1):
            parent, child = context.Pipe()
            process = context.Process(target=_serve, args=(child, self.memory.name, self.gradient_memory.name, row, str(maps_directory), group, count, seed), daemon=True)
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
        mine = local() if local else getattr(self.local, command)(*args)
        return [mine] + [parent.recv() for _, parent in self.workers]

    def update(self, rng, steps=128, epochs=4, minibatch=256, progress=None, interrupt=None):
        self.publish()
        results = self._all('rollout', steps, local=lambda: self.local.rollout(steps, progress, interrupt))
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
        episodes = [episode for r in results for episode in r['episodes']]
        metrics = {key: float(np.mean([stat[key] for stat in stats])) for key in stats[0]}
        return {'steps': total, 'episodes': episodes, 'reward': float(sum(r['reward'] for r in results)),
                'environments': self.count, 'processes': len(self.workers) + 1, **metrics}

    def close(self):
        for process, parent in self.workers:
            try:
                parent.send(('close',))
            except (OSError, BrokenPipeError):
                pass
        for process, _ in self.workers:
            process.join(timeout=3)
            if process.is_alive():
                process.terminate()
        self.workers = []
        self.local = self.weights = self.gradients = None
        for memory in (self.memory, self.gradient_memory):
            memory.close(); memory.unlink()
