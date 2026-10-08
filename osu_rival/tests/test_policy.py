import io
import json
import unittest
import zipfile

import numpy as np

from rival.environment import Environment
from _maps import real_map
from rival.policy import Policy, advantages_and_returns, conv_backward, conv_forward, evaluate, update


class PolicyTests(unittest.TestCase):
    def test_gae_does_not_bootstrap_across_episode_boundaries(self):
        advantages, returns = advantages_and_returns(np.array([1.,2.],np.float32),np.array([.4,.5],np.float32),[True,True],999)
        np.testing.assert_allclose(returns,[1,2])
        np.testing.assert_allclose(advantages,[.6,1.5])

    def test_convolution_gradient_matches_finite_differences(self):
        rng = np.random.default_rng(1)
        x = rng.normal(size=(2,2,8,9)).astype(np.float32)
        weights = rng.normal(size=(3,2,3,3)).astype(np.float32)
        bias = np.zeros(3,np.float32)
        output, cache = conv_forward(x,weights,bias)
        upstream = rng.normal(size=output.shape).astype(np.float32)
        dx, dw, db = conv_backward(upstream,weights,cache)
        def loss():
            return float((conv_forward(x,weights,bias)[0]*upstream).sum())
        for array, gradient, index in [(weights,dw,(1,1,1,1)),(x,dx,(1,0,3,3)),(bias,db,(2,))]:
            original=array[index].copy();epsilon=.005
            array[index]=original+epsilon;high=loss()
            array[index]=original-epsilon;low=loss()
            array[index]=original
            self.assertAlmostEqual(float(gradient[index]),(high-low)/(2*epsilon),delta=.003)

    def test_full_ppo_gradient_matches_finite_differences(self):
        rng = np.random.default_rng(5)
        policy = Policy(5)
        observations=rng.integers(0,256,(4,4,48,64),dtype=np.uint8)
        latents=rng.normal(size=(4,2)).astype(np.float32)
        keys=np.array([0,1,2,3])
        mean,probs,_=policy.forward(observations)
        old_logp=policy.log_probabilities(mean,probs,latents,keys).copy()
        advantages=np.array([.1,-.2,.4,-.3],np.float32)
        returns=np.array([.2,.1,.5,-.2],np.float32)
        arguments=(observations,latents,keys,old_logp,advantages,returns)
        _,gradients=policy.loss_and_gradients(*arguments)
        for name in ['c1w','c2w','fw','aw','ab','vw','logstd']:
            index=np.unravel_index(np.argmax(np.abs(gradients[name])),gradients[name].shape)
            array=policy.parameters[name];original=array[index].copy();epsilon=.001
            array[index]=original+epsilon;high=policy.loss_and_gradients(*arguments)[0]['loss']
            array[index]=original-epsilon;low=policy.loss_and_gradients(*arguments)[0]['loss']
            array[index]=original
            np.testing.assert_allclose(gradients[name][index],(high-low)/(2*epsilon),atol=.003,rtol=.08,err_msg=name)

    def test_checkpoint_roundtrip_preserves_actions_and_optimizer(self):
        policy=Policy(18);rng=np.random.default_rng(18);env=Environment(18,beatmap=real_map())
        update(policy,env,rng,steps=64,epochs=1)
        saved=policy.serialize({'seed':18,'updates':1,'stage':0})
        loaded,metadata=Policy.load(saved)
        self.assertEqual(loaded.optimizer_step,policy.optimizer_step)
        for name in policy.parameters:
            np.testing.assert_array_equal(loaded.parameters[name],policy.parameters[name])
            np.testing.assert_array_equal(loaded.m[name],policy.m[name])
        self.assertEqual(metadata['updates'],1)
        before=policy.sample(env.observation(),np.random.default_rng(18))
        after=loaded.sample(env.observation(),np.random.default_rng(18))
        np.testing.assert_array_equal(before[0],after[0]);self.assertEqual(before[1:],after[1:])

    def test_untrusted_checkpoint_array_header_is_rejected_before_allocation(self):
        policy=Policy()
        original=policy.serialize({'seed':42})
        source=zipfile.ZipFile(io.BytesIO(original));target=io.BytesIO()
        with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as destination:
            for entry in source.infolist():
                content=source.read(entry.filename)
                if entry.filename=='c1w.npy':
                    forged=io.BytesIO();np.lib.format.write_array_header_1_0(forged,{'descr':'<f4','fortran_order':False,'shape':(1000000000,)})
                    content=forged.getvalue()
                destination.writestr(entry.filename,content)
        with self.assertRaisesRegex(ValueError,'array header'):
            Policy.load(target.getvalue())

    def test_pickle_checkpoint_is_rejected(self):
        data=io.BytesIO();np.savez_compressed(data,metadata=np.array([{'payload':1}],dtype=object))
        with self.assertRaises(ValueError):Policy.load(data.getvalue())

    def test_training_changes_weights_using_rewards(self):
        policy=Policy(42);before=policy.parameters['aw'].copy()
        result=update(policy,Environment(42,beatmap=real_map()),np.random.default_rng(42),steps=128,epochs=2)
        self.assertFalse(np.array_equal(before,policy.parameters['aw']))
        self.assertTrue(np.isfinite(result['loss']))
        self.assertEqual(result['steps'],128)


if __name__ == '__main__':
    unittest.main()
