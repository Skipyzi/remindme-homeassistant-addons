"""Named models with independent weights, optimizer, evaluation and full-map runs."""
from pathlib import Path
import shutil
import time
import uuid

from .policy import Policy
from .storage import atomic_bytes,atomic_json,read_json

RUNTIME=('state.json','scene.json','frame.png','attempt.json','runs.json')


class Models:
    def __init__(self,directory,seed=42):
        self.root=Path(directory);self.seed=seed
        self.directory=self.root/'saved-models';self.directory.mkdir(exist_ok=True)
        self.path=self.root/'model-library.json'
        self.index=read_json(self.path)
        if self.index is None:
            ident=uuid.uuid4().hex
            self.index={'active':ident,'generation':uuid.uuid4().hex,'models':[{'id':ident,'name':'Original model','created_at':time.time()}]}
            self.save()

    @property
    def generation(self):return self.index['generation']

    def save(self):atomic_json(self.path,self.index)

    def find(self,ident):
        item=next((item for item in self.index['models'] if item['id']==ident),None)
        if item is None:raise ValueError('Model not found')
        return item

    def status(self):
        entries=[]
        for item in self.index['models']:
            active=item['id']==self.index['active']
            state=read_json((self.root if active else self.directory/item['id'])/'state.json',{})
            entries.append({**item,'active':active,'steps':state.get('steps',0),'updates':state.get('updates',0)})
        return {'active':self.index['active'],'generation':self.generation,'models':entries}

    def profile(self,ident,profile):
        item=self.find(ident)
        if profile is None:item.pop('profile',None)
        else:item['profile']=profile
        self.save();return self.status()

    def snapshot(self):
        latest=self.root/'models/latest.npz'
        run=read_json(self.root/'models/latest-run.json')
        if latest.exists() and run:
            import hashlib
            if run.get('checkpoint_sha256')!=hashlib.sha256(latest.read_bytes()).hexdigest():
                raise ValueError('The checkpoint is still synchronizing. Try again in a moment.')
        ident=self.index['active'];stage=self.directory/('.'+uuid.uuid4().hex)
        stage.mkdir()
        try:
            shutil.copytree(self.root/'models',stage/'models')
            for name in RUNTIME:
                path=self.root/name
                if path.exists():shutil.copy2(path,stage/name)
            if not (stage/'models/latest.npz').exists():
                policy=Policy(self.seed);metadata=self.fresh_metadata(self.seed)
                raw=policy.serialize(metadata)
                atomic_bytes(stage/'models/latest.npz',raw);atomic_bytes(stage/'models/initial.npz',raw)
                atomic_json(stage/'state.json',metadata|{'status':'paused'})
            target=self.directory/ident
            backup=self.directory/('.old-'+uuid.uuid4().hex)
            if target.exists():target.rename(backup)
            stage.rename(target)
            if backup.exists():shutil.rmtree(backup)
        finally:
            if stage.exists():shutil.rmtree(stage)

    @staticmethod
    def fresh_metadata(seed):
        return {'seed':seed,'steps':0,'updates':0,'episodes':0,'completed_maps':0,'stage':0,'history':[],'baselines':{},
                'training_format':'real-beatmap-v1','training_strategy':'full-maps-v1'}

    def replace_runtime(self,source):
        # Complete snapshots remain in saved-models if an interrupted filesystem write needs recovery.
        stage=self.root/('.models-'+uuid.uuid4().hex)
        shutil.copytree(source/'models',stage)
        _,metadata=Policy.load((stage/'latest.npz').read_bytes())
        assert metadata.get('training_format')=='real-beatmap-v1'
        old=self.root/('.previous-models-'+uuid.uuid4().hex)
        (self.root/'models').rename(old);stage.rename(self.root/'models')
        previous=read_json(self.root/'state.json',{})
        for name in RUNTIME:
            target=self.root/name;target.unlink(missing_ok=True)
            if (source/name).exists():atomic_bytes(target,(source/name).read_bytes())
        state=read_json(self.root/'state.json',metadata)
        state.update(status='paused',phase='Ready when you are',last_error=None)
        if 'map_sync' in previous:state['map_sync']=previous['map_sync']
        if 'worker_budget' in previous:state['worker_budget']=previous['worker_budget']
        atomic_json(self.root/'state.json',state)
        shutil.rmtree(old)

    def activate(self,ident):
        self.find(ident)
        if ident==self.index['active']:return self.status()
        source=self.directory/ident
        if not (source/'models/latest.npz').exists():raise ValueError('Saved model files are missing')
        self.snapshot();self.replace_runtime(source)
        self.index.update(active=ident,generation=uuid.uuid4().hex);self.save()
        return self.status()

    def new(self,name,replace=False):
        if not isinstance(name,str) or not name.strip() or len(name.strip())>60 or any(ord(c)<32 for c in name):
            raise ValueError('Use a model name from 1 to 60 characters')
        if len(self.index['models'])>=32 and not replace:raise ValueError('Discard a model before creating another; the limit is 32')
        self.snapshot()
        ident=uuid.uuid4().hex;source=self.directory/ident;(source/'models').mkdir(parents=True)
        seed=uuid.uuid4().int%2147483647
        policy=Policy(seed);metadata=self.fresh_metadata(seed);raw=policy.serialize(metadata)
        atomic_bytes(source/'models/latest.npz',raw);atomic_bytes(source/'models/initial.npz',raw)
        atomic_json(source/'state.json',metadata|{'status':'paused'})
        self.replace_runtime(source)
        self.index['models'].append({'id':ident,'name':name.strip(),'created_at':time.time()})
        self.index.update(active=ident,generation=uuid.uuid4().hex);self.save()
        return self.status()

    def discard(self,ident):
        self.find(ident)
        if ident==self.index['active']:
            # Keep the app ready to learn after discarding its current model.
            self.new('New model',replace=True)
        shutil.rmtree(self.directory/ident,ignore_errors=True)
        self.index['models']=[item for item in self.index['models'] if item['id']!=ident]
        self.save();return self.status()
