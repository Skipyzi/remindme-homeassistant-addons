"""A small convolutional actor/critic and clipped PPO, implemented in NumPy.

The action is a sampled latent mouse position and a categorical key state.
Mouse positions use tanh before reaching the environment. PPO stores and scores
the latent sample, so the common change-of-variables term cancels in its ratio.
"""
import io
import json
import math
import zipfile

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view

from .storage import atomic_bytes
from .rewards import DISCOUNT
from .vision import OBSERVATION_SHAPE,LEGACY_OBSERVATION_SHAPE,FEATURE_HEIGHT,FEATURE_WIDTH,LEGACY_FEATURE_HEIGHT,LEGACY_FEATURE_WIDTH,FEATURE_OFFSET

SHAPES = {
    'c1w': (4, 4, 5, 5), 'c1b': (4,),
    'c2w': (8, 4, 3, 3), 'c2b': (8,),
    'fw': (8*FEATURE_HEIGHT*FEATURE_WIDTH,32), 'fb': (32,),
    'aw': (32, 6), 'ab': (6,),
    'vw': (32, 1), 'vb': (1,), 'logstd': (2,),
}
LEGACY_SHAPES = {**SHAPES,'fw':(8*LEGACY_FEATURE_HEIGHT*LEGACY_FEATURE_WIDTH,32)}
LOG_2PI = math.log(2 * math.pi)
EVALUATION_REVISION='paired-seeds-v2'
EVALUATION_SEEDS=(91000,91011,91022)


def softmax(logits):
    values = np.exp(logits - logits.max(axis=-1, keepdims=True))
    return values / values.sum(axis=-1, keepdims=True)


def conv_forward(x, weights, bias, stride=2):
    kernel = weights.shape[-1]
    windows = sliding_window_view(x, (kernel, kernel), axis=(2, 3))[:, :, ::stride, ::stride]
    batch, channels, oh, ow, _, _ = windows.shape
    columns = windows.transpose(0, 2, 3, 1, 4, 5).reshape(batch*oh*ow, -1)
    output = (columns @ weights.reshape(weights.shape[0], -1).T + bias).reshape(batch, oh, ow, -1).transpose(0, 3, 1, 2)
    return output, (columns, x.shape, oh, ow)


def conv_backward(gradient, weights, cache, input_gradient=True, stride=2):
    columns, shape, oh, ow = cache
    batch, channels, _, _ = shape
    kernel = weights.shape[-1]
    flat = gradient.transpose(0, 2, 3, 1).reshape(-1, weights.shape[0])
    dw = (flat.T @ columns).reshape(weights.shape)
    db = flat.sum(axis=0)
    if not input_gradient:
        return None, dw, db
    dcolumns = (flat @ weights.reshape(weights.shape[0], -1)).reshape(batch, oh, ow, channels, kernel, kernel)
    dx = np.zeros(shape, np.float32)
    for y in range(kernel):
        for x in range(kernel):
            dx[:, :, y:y+oh*stride:stride, x:x+ow*stride:stride] += dcolumns[:, :, :, :, y, x].transpose(0, 3, 1, 2)
    return dx, dw, db


class Policy:
    def __init__(self, seed=42):
        rng = np.random.default_rng(seed)
        self.parameters = {}
        for name, shape in SHAPES.items():
            if name == 'logstd':
                values = np.full(shape, -.25, np.float32)
            elif name.endswith('b'):
                values = np.zeros(shape, np.float32)
            else:
                fan = math.prod(shape[1:]) if name.startswith('c') else shape[0]
                scale = .01 if name == 'aw' else math.sqrt(2 / fan)
                values = rng.normal(0, scale, shape).astype(np.float32)
            self.parameters[name] = values
        self.m = {key: np.zeros_like(value) for key, value in self.parameters.items()}
        self.v = {key: np.zeros_like(value) for key, value in self.parameters.items()}
        self.optimizer_step = 0

    @property
    def parameter_count(self):
        return sum(value.size for value in self.parameters.values())

    def forward(self, observations, cache=False):
        x = np.asarray(observations, dtype=np.float32) / 255
        if x.ndim == 3:
            x = x[None]
        if x.shape[1:] != OBSERVATION_SHAPE:
            raise ValueError('Expected four padded 80 by 64 pixel frames')
        p = self.parameters
        z1, cc1 = conv_forward(x, p['c1w'], p['c1b'])
        a1 = np.maximum(z1, 0)
        z2, cc2 = conv_forward(a1, p['c2w'], p['c2b'])
        a2 = np.maximum(z2, 0)
        flat = a2.reshape(len(x), -1)
        hidden = np.tanh(flat @ p['fw'] + p['fb'])
        actor = hidden @ p['aw'] + p['ab']
        values = (hidden @ p['vw'] + p['vb'])[:, 0]
        result = (actor[:, :2], softmax(actor[:, 2:]), values)
        if cache:
            return result, (z1, z2, flat, hidden, cc1, cc2)
        return result

    def sample(self, observation, rng):
        mean, probabilities, values = self.forward(observation)
        latent = mean[0] + np.exp(self.parameters['logstd']) * rng.normal(size=2)
        key = int(rng.choice(4, p=probabilities[0].astype(np.float64) / probabilities[0].sum(dtype=np.float64)))
        logp = self.log_probabilities(mean, probabilities, latent[None], np.array([key]))[0]
        return latent.astype(np.float32), key, float(logp), float(values[0])

    def log_probabilities(self, mean, probabilities, latents, keys):
        logstd = self.parameters['logstd']
        gaussian = -.5 * (((latents-mean) / np.exp(logstd)) ** 2 + 2*logstd + LOG_2PI).sum(axis=1)
        return gaussian + np.log(np.maximum(probabilities[np.arange(len(keys)), keys], 1e-12))

    def loss_and_gradients(self, observations, latents, keys, old_logp, advantages, returns,
                           clip=.2, value_coefficient=.5, entropy_coefficient=.01):
        (means, probabilities, values), cache = self.forward(observations, cache=True)
        logp = self.log_probabilities(means, probabilities, latents, keys)
        ratio = np.exp(np.clip(logp - old_logp, -20, 20))
        unclipped = ratio * advantages
        clipped = np.clip(ratio, 1-clip, 1+clip) * advantages
        active = ~(((advantages > 0) & (ratio > 1+clip)) | ((advantages < 0) & (ratio < 1-clip)))
        n = len(keys)
        derivative = -advantages * ratio * active / n
        entropy_keys = -(probabilities * np.log(np.maximum(probabilities, 1e-12))).sum(axis=1)
        entropy_normal = (self.parameters['logstd'] + .5*(1+LOG_2PI)).sum()
        entropy = entropy_keys.mean() + entropy_normal
        policy_loss = -np.minimum(unclipped, clipped).mean()
        value_loss = ((values - returns) ** 2).mean()
        total = policy_loss + value_coefficient*value_loss - entropy_coefficient*entropy
        dmean = derivative[:, None] * (latents-means) / np.exp(2*self.parameters['logstd'])
        one_hot = np.eye(4, dtype=np.float32)[keys]
        dkeys = derivative[:, None] * (one_hot-probabilities)
        dkeys += entropy_coefficient / n * probabilities * (np.log(np.maximum(probabilities, 1e-12)) + entropy_keys[:, None])
        dactor = np.concatenate((dmean, dkeys), axis=1).astype(np.float32)
        dvalue = (2*value_coefficient*(values-returns) / n)[:, None]
        z1, z2, flat, hidden, cc1, cc2 = cache
        p = self.parameters
        grads = {'aw': hidden.T @ dactor, 'ab': dactor.sum(axis=0),
                 'vw': hidden.T @ dvalue, 'vb': dvalue.sum(axis=0),
                 'logstd': (derivative[:, None] * (((latents-means)/np.exp(p['logstd']))**2-1)).sum(axis=0) - entropy_coefficient}
        dhidden = (dactor @ p['aw'].T + dvalue @ p['vw'].T) * (1-hidden**2)
        grads['fw'], grads['fb'] = flat.T @ dhidden, dhidden.sum(axis=0)
        dz2 = (dhidden @ p['fw'].T).reshape(z2.shape) * (z2 > 0)
        da1, grads['c2w'], grads['c2b'] = conv_backward(dz2, p['c2w'], cc2)
        _, grads['c1w'], grads['c1b'] = conv_backward(da1 * (z1 > 0), p['c1w'], cc1, input_gradient=False)
        metrics = {'loss': float(total), 'policy_loss': float(policy_loss), 'value_loss': float(value_loss),
                   'entropy': float(entropy), 'approx_kl': float(((ratio-1) - (logp-old_logp)).mean()),
                   'clip_fraction': float((~active).mean())}
        return metrics, {key: value.astype(np.float32) for key, value in grads.items()}

    def optimize(self, gradients, learning_rate=3e-4):
        if any(not np.isfinite(value).all() for value in gradients.values()):
            raise FloatingPointError('Training produced a non-finite gradient')
        norm = math.sqrt(sum(float(np.sum(value.astype(np.float64)**2)) for value in gradients.values()))
        factor = min(1.0, .5 / max(norm, 1e-12))
        self.optimizer_step += 1
        t = self.optimizer_step
        for key, parameter in self.parameters.items():
            gradient = gradients[key] * factor
            self.m[key] = .9*self.m[key] + .1*gradient
            self.v[key] = .999*self.v[key] + .001*gradient**2
            parameter -= learning_rate * (self.m[key]/(1-.9**t)) / (np.sqrt(self.v[key]/(1-.999**t)) + 1e-8)
        np.clip(self.parameters['logstd'], -2, 1, out=self.parameters['logstd'])

    def serialize(self, metadata):
        metadata = {key:value for key,value in metadata.items() if key!='migrated_from_observation'}
        metadata = {**metadata, 'format': 2, 'optimizer_step': self.optimizer_step,
                    'parameters': self.parameter_count, 'observation':list(OBSERVATION_SHAPE)}
        values = {**self.parameters, **{'m_'+key: value for key, value in self.m.items()},
                  **{'v_'+key: value for key, value in self.v.items()},
                  'metadata': np.frombuffer(json.dumps(metadata, allow_nan=False).encode(), dtype=np.uint8)}
        stream = io.BytesIO()
        np.savez_compressed(stream, **values)
        return stream.getvalue()

    def save(self, path, metadata):
        atomic_bytes(path, self.serialize(metadata))

    @classmethod
    def load(cls, data):
        if len(data) > 4 * 1024 * 1024:
            raise ValueError('Checkpoint is larger than 4 MB')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 50 or sum(item.file_size for item in entries) > 4 * 1024 * 1024:
                raise ValueError('Checkpoint expands beyond the size limit')
            expected = {prefix+name+'.npy': shape for name, shape in SHAPES.items() for prefix in ['', 'm_', 'v_']}
            expected['metadata.npy'] = None
            if len({item.filename for item in entries}) != len(entries) or {item.filename for item in entries} != set(expected):
                raise ValueError('Unexpected checkpoint contents')
            # Check .npy headers before NumPy allocates an array. A tiny archive
            # with a forged, enormous shape must not exhaust the app's memory.
            for item in entries:
                with archive.open(item) as handle:
                    version = np.lib.format.read_magic(handle)
                    if version == (1, 0):
                        shape, _, dtype = np.lib.format.read_array_header_1_0(handle)
                    elif version == (2, 0):
                        shape, _, dtype = np.lib.format.read_array_header_2_0(handle)
                    else:
                        raise ValueError('Unsupported array format')
                    if item.filename == 'metadata.npy':
                        valid = dtype == np.uint8 and len(shape) == 1 and 0 < shape[0] <= 65536
                    else:
                        valid = dtype == np.float32 and (shape == expected[item.filename] or
                            item.filename in ('fw.npy','m_fw.npy','v_fw.npy') and shape == LEGACY_SHAPES['fw'])
                    if not valid or handle.tell()+math.prod(shape)*dtype.itemsize != item.file_size:
                        raise ValueError('Invalid checkpoint array header')
        policy = cls()
        with np.load(io.BytesIO(data), allow_pickle=False) as values:
            if values['metadata'].dtype != np.uint8 or values['metadata'].size > 65536:
                raise ValueError('Invalid checkpoint metadata')
            metadata = json.loads(values['metadata'].tobytes())
            if not isinstance(metadata,dict):
                raise ValueError('Invalid checkpoint metadata')
            legacy = metadata.get('format')==1 and metadata.get('observation')==list(LEGACY_OBSERVATION_SHAPE)
            current = metadata.get('format')==2 and metadata.get('observation')==list(OBSERVATION_SHAPE)
            if not legacy and not current:
                raise ValueError('Incompatible checkpoint format')
            source_shapes = LEGACY_SHAPES if legacy else SHAPES
            step = metadata.get('optimizer_step')
            if isinstance(step, bool) or not isinstance(step, int) or not 0 <= step <= 10**12:
                raise ValueError('Invalid optimizer state')
            policy.optimizer_step = step
            for name, shape in source_shapes.items():
                for prefix, target in [('', policy.parameters), ('m_', policy.m), ('v_', policy.v)]:
                    array = values[prefix+name]
                    if array.shape != shape or array.dtype != np.float32 or not np.isfinite(array).all():
                        raise ValueError('Invalid checkpoint weights')
                    if prefix == 'v_' and (array < 0).any():
                        raise ValueError('Invalid optimizer variance')
                    if legacy and name=='fw':
                        expanded = np.zeros((8,FEATURE_HEIGHT,FEATURE_WIDTH,32),np.float32)
                        expanded[:,FEATURE_OFFSET:FEATURE_OFFSET+LEGACY_FEATURE_HEIGHT,
                                 FEATURE_OFFSET:FEATURE_OFFSET+LEGACY_FEATURE_WIDTH] = array.reshape(8,LEGACY_FEATURE_HEIGHT,LEGACY_FEATURE_WIDTH,32)
                        target[name] = expanded.reshape(SHAPES[name])
                    else:
                        target[name] = array.copy()
        if legacy:
            metadata['migrated_from_observation']=list(LEGACY_OBSERVATION_SHAPE)
            metadata['format']=2
            metadata['observation']=list(OBSERVATION_SHAPE)
        if (np.abs(policy.parameters['logstd']) > 10).any():
            raise ValueError('Invalid exploration scale')
        return policy, metadata


def advantages_and_returns(rewards, values, dones, bootstrap, gamma=DISCOUNT, lam=.95):
    advantages = np.zeros(len(rewards), np.float32)
    last = 0.0
    for index in reversed(range(len(rewards))):
        following = bootstrap if index == len(rewards)-1 else values[index+1]
        continuation = 0.0 if dones[index] else 1.0
        delta = rewards[index] + gamma*following*continuation - values[index]
        last = delta + gamma*lam*continuation*last
        advantages[index] = last
    return advantages, advantages + values


def evaluate(policy, sections, seed=91000, tick=None):
    from .environment import Environment
    results = []
    for index,section in enumerate(sections):
        env = Environment(seed=seed+index, section=section)
        rng = np.random.default_rng(seed+index+100000)
        observation,done = env.observation(),False
        while not done:
            if tick:
                tick()
            latent,keys,_,_ = policy.sample(observation,rng)
            observation,_,done = env.step((latent,keys))
        results.append(env.summary())
    objects = sum(result['objects'] for result in results)
    return {'episodes':len(sections),'objects':objects,
            'hit_rate':sum(result['hits'] for result in results)/max(1,objects),
            'accuracy':sum(result['points'] for result in results)/max(1,300*objects),
            'seed':seed}


def evaluate_many(policy,sections,seeds=EVALUATION_SEEDS,tick=None):
    """Raw osu! judgments across paired seeds, with batched visual inference."""
    from .environment import Environment
    if not seeds:raise ValueError('At least one evaluation seed is required')
    entries=[(Environment(seed=seed+index,section=section),np.random.default_rng(seed+index+100000),seed)
             for seed in seeds for index,section in enumerate(sections)]
    active=list(entries)
    while active:
        if tick:tick()
        # Bound temporary convolution buffers on the Pi as well as on a workstation.
        following=[]
        for start in range(0,len(active),8):
            batch=active[start:start+8]
            means,probabilities,_=policy.forward(np.stack([env.observation() for env,_,_ in batch]))
            for row,(env,rng,seed) in enumerate(batch):
                latent=(means[row]+np.exp(policy.parameters['logstd'])*rng.normal(size=2)).astype(np.float32)
                probabilities_row=probabilities[row].astype(np.float64);probabilities_row/=probabilities_row.sum()
                keys=int(rng.choice(4,p=probabilities_row))
                _,_,done=env.step((latent,keys))
                if not done:following.append((env,rng,seed))
        active=following
    objects=sum(len(env.objects) for env,_,_ in entries)
    return {'episodes':len(entries),'objects':objects,'unique_objects':objects//len(seeds),
            'hit_rate':sum(env.summary()['hits'] for env,_,_ in entries)/max(1,objects),
            'accuracy':sum(env.summary()['points'] for env,_,_ in entries)/max(1,300*objects),
            'seeds':list(seeds),'seed_count':len(seeds),'protocol':EVALUATION_REVISION}


def update(policy, env, rng, steps=512, epochs=4, minibatch=32, progress=None, interrupt=None):
    observations, latents, keys, logps, values, rewards, dones = [], [], [], [], [], [], []
    episodes = []
    reward_stats={'score_reward':0.0,'feedback_reward':0.0,'score_events':0,'feedback_events':0}
    observation = env.observation()
    for index in range(steps):
        if interrupt and interrupt():
            return None
        latent, key, logp, value = policy.sample(observation, rng)
        observations.append(observation)
        latents.append(latent)
        keys.append(key)
        logps.append(logp)
        values.append(value)
        observation, reward, done = env.step((latent, key))
        reward_stats['score_reward']+=env.last_reward['score'];reward_stats['feedback_reward']+=env.last_reward['feedback']
        reward_stats['score_events']+=int(env.last_reward['score']!=0);reward_stats['feedback_events']+=int(abs(env.last_reward['feedback'])>1e-8)
        rewards.append(reward)
        dones.append(done)
        if progress:
            progress(env, index)
        if done:
            episodes.append(env.summary())
            observation = env.reset()
    bootstrap = float(policy.forward(observation)[2][0])
    data = [np.asarray(observations, np.uint8), np.asarray(latents, np.float32),
            np.asarray(keys, np.int64), np.asarray(logps, np.float32)]
    advantages, returns = advantages_and_returns(np.array(rewards, np.float32), np.array(values, np.float32), dones, bootstrap)
    normalized = (advantages-advantages.mean()) / max(float(advantages.std()), 1e-6)
    stats = []
    for _ in range(epochs):
        if interrupt and interrupt():
            return None
        order = rng.permutation(steps)
        for start in range(0, steps, minibatch):
            if interrupt and interrupt():
                return None
            chosen = order[start:start+minibatch]
            metrics, gradients = policy.loss_and_gradients(*(value[chosen] for value in data), normalized[chosen], returns[chosen])
            policy.optimize(gradients)
            stats.append(metrics)
        if np.mean([item['approx_kl'] for item in stats[-math.ceil(steps/minibatch):]]) > .03:
            break
    metrics = {key: float(np.mean([stat[key] for stat in stats])) for key in stats[0]}
    return {'steps': steps, 'episodes': episodes, 'reward': float(np.sum(rewards)), **reward_stats, **metrics}
