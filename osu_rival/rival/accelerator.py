"""Optional PyTorch PPO optimizer. Rollouts and the portable checkpoint remain NumPy.

Imported only by a workstation with GPU training selected. CPU/Pi installs do
not need PyTorch. Adam moments and step numbers travel with the existing model.
"""
import numpy as np

from .policy import LOG_2PI


def capabilities():
    try:
        import torch
        if not torch.cuda.is_available():
            return {'available': False, 'reason': 'PyTorch cannot access a supported GPU'}
        # Check a real kernel, not just PCI enumeration.
        result = (torch.ones(2, device='cuda') * 2).sum().item()
        if result != 4:
            raise RuntimeError('GPU kernel check failed')
        return {'available': True, 'name': torch.cuda.get_device_name(0),
                'runtime': 'ROCm' if torch.version.hip else 'CUDA', 'torch': torch.__version__}
    except (ImportError, OSError, RuntimeError) as error:
        return {'available': False, 'reason': str(error)[:240]}


class Optimizer:
    def __init__(self, policy, device='cuda'):
        import torch
        self.torch, self.device, self.policy = torch, device, policy
        torch.set_num_threads(1)
        self.p = {k: torch.tensor(v, device=device, requires_grad=True) for k, v in policy.parameters.items()}
        self.m = {k: torch.tensor(v, device=device) for k, v in policy.m.items()}
        self.v = {k: torch.tensor(v, device=device) for k, v in policy.v.items()}
        self.step = policy.optimizer_step
        self.adam = torch.optim.Adam(list(self.p.values()), lr=3e-4, fused=device.startswith('cuda'))
        for k, p in self.p.items():
            self.adam.state[p] = {'step': torch.tensor(float(self.step), device=device if device.startswith('cuda') else 'cpu'),
                                 'exp_avg': self.m[k], 'exp_avg_sq': self.v[k]}

    def forward(self, x):
        t, p = self.torch, self.p
        x = x.float() / 255
        x = t.nn.functional.relu(t.nn.functional.conv2d(x, p['c1w'], p['c1b'], stride=2))
        x = t.nn.functional.relu(t.nn.functional.conv2d(x, p['c2w'], p['c2b'], stride=2))
        h = t.tanh(x.flatten(1) @ p['fw'] + p['fb'])
        actor = h @ p['aw'] + p['ab']
        return actor[:, :2], t.softmax(actor[:, 2:], dim=1), (h @ p['vw'] + p['vb'])[:, 0]

    def loss(self, observations, latents, keys, old_logp, advantages, returns):
        t, p = self.torch, self.p
        means, probabilities, values = self.forward(observations)
        logp = -.5 * (((latents-means) / p['logstd'].exp())**2 + 2*p['logstd'] + LOG_2PI).sum(1)
        logp = logp + probabilities[t.arange(len(keys), device=self.device), keys].clamp_min(1e-12).log()
        ratio = (logp-old_logp).clamp(-20, 20).exp()
        active = ~(((advantages > 0) & (ratio > 1.2)) | ((advantages < 0) & (ratio < .8)))
        entropy = -(probabilities * probabilities.clamp_min(1e-12).log()).sum(1).mean()
        entropy = entropy + (p['logstd'] + .5*(1+LOG_2PI)).sum()
        policy_loss = -t.minimum(ratio*advantages, ratio.clamp(.8, 1.2)*advantages).mean()
        value_loss = ((values-returns)**2).mean()
        loss = policy_loss + .5*value_loss - .01*entropy
        return loss, {'loss': loss, 'policy_loss': policy_loss, 'value_loss': value_loss,
                      'entropy': entropy, 'approx_kl': ((ratio-1)-(logp-old_logp)).mean(),
                      'clip_fraction': (~active).float().mean()}

    def optimize(self):
        t = self.torch
        with t.no_grad():
            norm = t.sqrt(sum((v.grad.double()**2).sum() for v in self.p.values()))
            if not t.isfinite(norm).item():
                raise FloatingPointError('Training produced a non-finite gradient')
            factor = (.5 / norm.clamp_min(1e-12)).clamp_max(1).float()
            t._foreach_mul_([p.grad for p in self.p.values()], factor)
            self.adam.step()
            self.step += 1
            self.adam.zero_grad(set_to_none=True)
            self.p['logstd'].clamp_(-2, 1)

    def export(self):
        for k in self.p:
            self.policy.parameters[k][...] = self.p[k].detach().cpu().numpy()
            self.policy.m[k] = self.m[k].cpu().numpy().copy()
            self.policy.v[k] = self.v[k].cpu().numpy().copy()
        self.policy.optimizer_step = self.step

    def update(self, shards, rng, epochs, minibatch, interrupt=None):
        t = self.torch
        data = [t.as_tensor(np.concatenate([s[i] for s in shards]), device=self.device) for i in range(6)]
        total, stats = len(data[0]), []
        try:
            for _ in range(epochs):
                epoch = []
                order = t.as_tensor(rng.permutation(total), device=self.device)
                for start in range(0, total, minibatch):
                    if interrupt and interrupt():
                        return None
                    chosen = order[start:start+minibatch]
                    loss, metrics = self.loss(*(v[chosen] for v in data))
                    loss.backward(); self.optimize()
                    metrics = {k: float(v.detach().item()) for k, v in metrics.items()}
                    epoch.append(metrics); stats.append(metrics)
                if np.mean([s['approx_kl'] for s in epoch]) > .03:
                    break
            return stats
        finally:
            self.export()
