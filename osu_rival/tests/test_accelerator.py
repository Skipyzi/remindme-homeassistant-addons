"""Parity of the optional optimizer with the existing portable learner."""
import unittest
import numpy as np
from _maps import real_map
from rival.environment import Environment
from rival.policy import Policy


class AcceleratorTests(unittest.TestCase):
    def test_forward_loss_gradients_and_existing_adam_state(self):
        try:
            import torch
        except ImportError:
            self.skipTest('Optional PyTorch runtime is not installed')
        from rival.accelerator import Optimizer
        env = Environment(beatmap=real_map())
        observations = []
        for _ in range(4):
            observations.append(env.observation())
            env.step((np.zeros(2, np.float32), 0))
        observations = np.stack(observations)
        policy = Policy(4)
        latents = np.array([[.2, -.1], [.1, .3], [-.2, .4], [.3, .2]], np.float32)
        keys = np.array([0, 1, 2, 3])
        means, probabilities, _ = policy.forward(observations)
        old_logp = policy.log_probabilities(means, probabilities, latents, keys)
        advantages = np.array([.3, -.2, .4, -.1], np.float32)
        returns = np.array([.3, .1, .2, -.1], np.float32)
        args = (observations, latents, keys, old_logp, advantages, returns)
        # Start with non-zero moments; a device switch must retain training.
        _, gradients = policy.loss_and_gradients(*args)
        policy.optimize(gradients)
        original = policy.serialize({'training_format': 'real-beatmap-v1'})
        for device in ['cpu'] + (['cuda'] if torch.cuda.is_available() else []):
            reference, _ = Policy.load(original)
            accelerated, _ = Policy.load(original)
            optimizer = Optimizer(accelerated, device=device)
            tensors = [torch.as_tensor(a, device=device) for a in args]
            for a, b in zip(reference.forward(observations), optimizer.forward(tensors[0])):
                np.testing.assert_allclose(a, b.detach().cpu().numpy(), atol=2e-5, rtol=2e-4)
            metrics, gradients = reference.loss_and_gradients(*args)
            loss, actual = optimizer.loss(*tensors)
            loss.backward()
            for key, gradient in gradients.items():
                np.testing.assert_allclose(gradient, optimizer.p[key].grad.cpu().numpy(), atol=2e-5, rtol=3e-3, err_msg=key)
            for key in metrics:
                self.assertAlmostEqual(metrics[key], actual[key].item(), places=4)
            reference.optimize(gradients)
            optimizer.optimize(); optimizer.export()
            self.assertEqual(reference.optimizer_step, accelerated.optimizer_step)
            for name in ['parameters', 'm', 'v']:
                for key in reference.parameters:
                    np.testing.assert_allclose(getattr(reference, name)[key], getattr(accelerated, name)[key], atol=2e-6, rtol=3e-3, err_msg=name+key)
            resumed, _ = Policy.load(accelerated.serialize({'training_format': 'real-beatmap-v1'}))
            self.assertEqual(resumed.optimizer_step, accelerated.optimizer_step)

