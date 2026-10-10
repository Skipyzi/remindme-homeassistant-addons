"""Saving cadence must never lose an explicit pause's model or playheads."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from rival.policy import Policy
from rival.storage import atomic_json, read_json
from rival.worker import Worker, StopWorker
from test_remote import library_with
from _maps import real_maps


class WorkerTests(unittest.TestCase):
    def test_periodic_save_skips_disk_work_but_pause_always_saves(self):
        real_maps()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            library_with(root)
            atomic_json(root/'worker-options.json',{'cpu_budget_percent':100})
            atomic_json(root/'control.json',{'running':True})
            worker=Worker(root)
            with patch('rival.worker.time.monotonic',return_value=100):worker.checkpoint()
            before=(root/'models/latest.npz').read_bytes()
            worker.state['updates']+=1
            worker.state['steps']=123_000
            worker.state['last_evaluation_steps']=100_000
            worker.env.step((np.zeros(2),0))
            with patch('rival.worker.time.monotonic',return_value=101):worker.checkpoint(force=False)
            self.assertEqual(before,(root/'models/latest.npz').read_bytes())
            # A pause before the next periodic save still goes through finally.
            with patch.object(worker,'tick',side_effect=StopWorker()), patch('rival.worker.os.sched_setaffinity'):
                worker.run()
            checkpoint=(root/'models/latest.npz').read_bytes()
            saved=read_json(root/'models/latest-run.json')
            self.assertEqual(saved['checkpoint_sha256'],hashlib.sha256(checkpoint).hexdigest())
            _,metadata=Policy.load(checkpoint)
            self.assertEqual(metadata['updates'],1)
            self.assertEqual(saved['run']['time'],worker.env.time)
            resumed=Worker(root)
            self.assertEqual(resumed.env.save_run(),worker.env.save_run())
            self.assertEqual(resumed.last_evaluation_steps,100_000)

