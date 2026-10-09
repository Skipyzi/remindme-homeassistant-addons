import io
import json
import unittest
import zipfile

import numpy as np

from rival.environment import Environment
from _maps import real_map
from rival.vision import OBSERVATION_SHAPE,PADDING,FEATURE_HEIGHT,FEATURE_WIDTH,FEATURE_OFFSET
from rival.policy import Policy, advantages_and_returns, conv_backward, conv_forward, evaluate, evaluate_many, update, LEGACY_SHAPES, softmax


class PolicyTests(unittest.TestCase):
    def test_batched_evaluation_matches_individual_raw_judgments(self):
        beatmap=real_map();sections=[(beatmap,0,6000)]
        policy=Policy(42);seeds=(91000,91011,91022)
        individual=[evaluate(policy,sections,seed=seed) for seed in seeds]
        before={key:value.copy() for key,value in policy.parameters.items()}
        combined=evaluate_many(policy,sections,seeds)
        self.assertEqual(combined['objects'],sum(result['objects'] for result in individual))
        self.assertEqual(combined['episodes'],3)
        self.assertEqual(combined['unique_objects'],individual[0]['objects'])
        for key in ('accuracy','hit_rate'):
            self.assertAlmostEqual(combined[key],float(np.mean([result[key] for result in individual])))
        for key,value in before.items():np.testing.assert_array_equal(value,policy.parameters[key])

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
        observations=rng.integers(0,256,(4,*OBSERVATION_SHAPE),dtype=np.uint8)
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

    def test_legacy_checkpoint_preserves_predictions_and_adam_state(self):
        rng=np.random.default_rng(7)
        parameters={name:rng.normal(0,.05,shape).astype(np.float32) for name,shape in LEGACY_SHAPES.items()}
        parameters['logstd'].fill(-.25)
        m={name:rng.normal(0,.01,shape).astype(np.float32) for name,shape in LEGACY_SHAPES.items()}
        v={name:rng.uniform(0,.01,shape).astype(np.float32) for name,shape in LEGACY_SHAPES.items()}
        metadata={'format':1,'observation':[4,48,64],'optimizer_step':7,'seed':42,'training_format':'real-beatmap-v1'}
        contents={**parameters,**{'m_'+name:value for name,value in m.items()},**{'v_'+name:value for name,value in v.items()},
                  'metadata':np.frombuffer(json.dumps(metadata).encode(),dtype=np.uint8)}
        stream=io.BytesIO();np.savez_compressed(stream,**contents)
        policy,loaded=Policy.load(stream.getvalue())
        self.assertEqual(loaded['migrated_from_observation'],[4,48,64]);self.assertEqual(policy.optimizer_step,7)
        env=Environment(beatmap=real_map());padded=env.observation()
        original=padded[:,PADDING:PADDING+48,PADDING:PADDING+64][None].astype(np.float32)/255
        a1=np.maximum(conv_forward(original,parameters['c1w'],parameters['c1b'])[0],0)
        a2=np.maximum(conv_forward(a1,parameters['c2w'],parameters['c2b'])[0],0)
        hidden=np.tanh(a2.reshape(1,-1)@parameters['fw']+parameters['fb'])
        actor=hidden@parameters['aw']+parameters['ab']
        expected=(actor[:,:2],softmax(actor[:,2:]),(hidden@parameters['vw']+parameters['vb'])[:,0])
        for before,after in zip(expected,policy.forward(padded)):
            np.testing.assert_allclose(before,after,atol=2e-6,rtol=2e-5)
        for source,target in [(parameters,policy.parameters),(m,policy.m),(v,policy.v)]:
            for name,value in source.items():
                if name=='fw':
                    expanded=target[name].reshape(8,FEATURE_HEIGHT,FEATURE_WIDTH,32)
                    np.testing.assert_array_equal(expanded[:,FEATURE_OFFSET:FEATURE_OFFSET+10,FEATURE_OFFSET:FEATURE_OFFSET+14],value.reshape(8,10,14,32))
                    outside=expanded.copy();outside[:,FEATURE_OFFSET:FEATURE_OFFSET+10,FEATURE_OFFSET:FEATURE_OFFSET+14]=0
                    self.assertEqual(np.count_nonzero(outside),0)
                else:np.testing.assert_array_equal(target[name],value)
        saved,metadata=Policy.load(policy.serialize(loaded))
        self.assertNotIn('migrated_from_observation',metadata)
        np.testing.assert_array_equal(saved.parameters['fw'],policy.parameters['fw'])

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
