# osu! Rival

A small Home Assistant app that learns osu!standard from pixels and rewards on
real beatmaps. It runs a NumPy worker on a Raspberry Pi 5 or a paired PC, with multiple processes sharing one model. Player replays and
pretrained weights are never used.

Press **Start training**. With an empty map library, the app copies `.osu` files
already cached by the private osu! server. It makes no upstream requests. You
can also import an original `.osu` file. All saved maps can participate in
training after the worker next starts. There is no generated-map fallback.

The model sees four 80 × 64 grayscale frames with margins. It chooses the cursor position
and the Z/X key state. A small PPO implementation updates its roughly 65,000
parameters using judgments from its own actions. Only the environment reads the
beatmap coordinates and timing; these values never enter the policy.

Training plays complete maps, starting with easier maps and cycling through all
training maps. It moves on after the final object regardless of accuracy. Small
PPO updates continue during each map; they never restart the playhead. Pause and
resume retain the current map, judgments and image stack alongside the model.
Evaluation uses short sections of withheld maps so checks stay inexpensive.
With only one map, the app reports no independent test accuracy.

The practice judge ports default osu!lazer timing, input ordering, stacking,
slider tracking and spinner rotation rules. Slider heads, ticks, repeats and
tails have separate accuracy and combo judgments. The learner must hold a key
and follow the moving ball to collect slider parts. Inputs use 60 Hz steps and
sampled slider curves. Health, mods, skin graphics and audio remain absent.
Practice accuracy is separate from normalized leaderboard scores and pp.

The app saves after each completed update. Start and Pause are the training
controls. It defaults to one thread, 25% of one CPU core, and a 512 MB worker
memory limit. It waits when available host memory is below 768 MB or the Pi is
above 75°C. These are resource guards, not a hard container CPU quota.

**Watch an attempt** records the saved model on a complete current training map or a
selected map. **Play against it** is a local browser practice challenge.
Native osu! multiplayer participation and leaderboard submission remain
unimplemented. The UI states this explicitly.

## Server cache bridge

The server-side companion is `rootfs/opt/osu/home_rival_maps.py` in the private
osu-server repository. It exposes these read-only routes:

- `GET /api/home/rival/maps?limit=100`
- `GET /api/home/rival/maps/{beatmap_id}/raw`

The bridge reads only `beatmap:*:raw` Redis keys. It does not read users, scores
or replays, refresh cache expiry, download missing files, or call the upstream
fetcher. A missing raw file returns 404. Catalogue work and file sizes are
bounded. These files contain public beatmap content.

The default app URL is `http://local-osu-server:8087` on the Home Assistant
internal app network. Override `beatmap_server_url` for another installation.
Original `.osu` text and parsed maps persist in `/data/maps`; models persist in
`/data/models`. Home Assistant backups include them.

## Development

Install the pinned requirements, then run from this folder:

```sh
RIVAL_TEST_MAP=/path/to/actual-map.osu OPENBLAS_NUM_THREADS=1 python3 -m unittest discover -s tests -v
python3 -m rival.server --data /tmp/osu-rival --host 127.0.0.1 --port 8099
```

The model can be measured only with a library of actual imported maps:

```sh
PYTHONPATH=. OPENBLAS_NUM_THREADS=1 python3 scripts/benchmark_learning.py \
  --maps /tmp/osu-rival/maps --checkpoint /tmp/osu-rival/models/latest.npz \
  --updates 200 --output /tmp/score-only.json
PYTHONPATH=. OPENBLAS_NUM_THREADS=1 python3 scripts/benchmark_learning.py \
  --maps /tmp/osu-rival/maps --checkpoint /tmp/osu-rival/models/latest.npz \
  --updates 200 --feedback --output /tmp/aim-feedback.json
```

Keep the source checkpoint and map library unchanged between those commands.
They start equal full-map runs and write reports without replacing saved models.

For a broader comparison with the starting model, run:

```sh
PYTHONPATH=. OPENBLAS_NUM_THREADS=1 python3 scripts/compare_checkpoints.py \
  --maps /path/to/saved/maps --current /path/to/copied/latest.npz \
  --initial /path/to/copied/initial.npz --output /tmp/paired-comparison.json
```

This samples two additional sections per withheld map and five new matched
action seeds. It excludes the chart's sections, compares a control with only
trained output biases, and reports a paired confidence interval by resampling
whole maps. It reads copied checkpoints and never updates or installs weights.

A frozen model at update 1,627 scored 9.88% on 40 additional sections across
20 withheld maps and five new seeds, versus 6.09% for its starting model. A
control using only trained output biases scored 7.70%. The paired map
bootstrap estimated a gain over the starting model of 2.74 to 4.87 percentage
points at 95% confidence. This supports modest improvement on this library;
accuracy remains poor, and one checkpoint does not establish continued gains
or reliable native play. The report is `validation/paired-learning-20261010.json`.

Before the lazer rule port, a 200-update comparison using the earlier practice
judge reached 10.3% withheld accuracy with aim feedback versus 8.6% with score
rewards alone. Those numbers do not establish improvement under the new judge. This is one training seed, scored
with three action seeds on 12 real sections. Improvement was small and not
monotonic; it does not establish strong native osu! play. Results are in
`validation/learning-feedback.json`.

Check Python/browser rule agreement on original .osu fixtures, with Node installed:

```sh
PYTHONPATH=. OPENBLAS_NUM_THREADS=1 python3 scripts/check_rules_parity.py \
  --maps /path/to/actual-osu-fixtures --report /tmp/lazer-rule-parity.json
```

These verification actions never become training demonstrations. The rule port
and remaining differences from the native client are documented in
`THIRD_PARTY_NOTICES.md`.


## Workstation resources and GPU learning

Open **Trainer settings** on the Training card after a PC connects. Choose CPU
cores, parallel runs and CPU or GPU learning, then **Apply settings**. Use at
least one run per core. Four cores and eight runs remain the default on this
workstation. Changes save the existing model and all map positions before
recreating the worker. Runs removed from the active set wait in the saved
sidecar and resume when enabled again. Settings persist separately from models. When CPU shard assignments change,
action RNG streams are reseeded for the new groups; unchanged layouts retain
exact RNG state.

GPU learning uses PyTorch for batched visual inference, PPO gradients and Adam
on the GPU. Simulation and rendering still run in CPU processes. The optional
backend imports no PyTorch on the Pi. CPU and GPU share `.npz` weights, optimizer
moments and step numbers. GPU selection requires a successful device kernel
check; an unavailable GPU reports an error rather than silently claiming
acceleration. Compare complete update throughput, since this network is small.

The Linux workstation uses the AMD PyTorch 2.8.0 / ROCm 7.0.2 eager runtime from
[AMD's installation instructions](https://rocm.docs.amd.com/projects/radeon-ryzen/en/docs-7.0.2/docs/install/installrad/native_linux/install-pytorch.html).
The host amdgpu driver stays in place. The runtime is installed outside the
container image under `~/.local/share/osu-rival-gpu/runtime` to avoid duplicating
11.7 GB across image layers. `Dockerfile.gpu` adds the small system libraries.
The trainer service mounts `runtime/lib/python3.12/site-packages` read-only at
`/opt/gpu` and passes `/dev/kfd` and `/dev/dri/renderD128`. GPU cache files live
under the trainer's `/data/gpu-cache`. PyTorch compilation, torchvision,
torchaudio and Triton are not used by this eager optimizer.

For a new installation, use Python 3.12 in the same container as the trainer.
Install the AMD wheel directly with `pip install --prefix /gpu/runtime
--no-deps WHEEL`, plus its eager dependencies: filelock, typing-extensions,
setuptools, sympy, networkx, jinja2, fsspec, MarkupSafe and mpmath. Use a prefix,
not `--target`, to avoid an extra full runtime copy during installation. Mount
`/gpu` to the workstation's GPU directory. The exact installed versions and
validation results are recorded in `validation/workstation-gpu.json`. The alternating
four-core/eight-run comparison measured about 1,160 steps/s on CPU and 1,057 on
GPU, so CPU remains the default for this small model. Desktop workloads affect
these timings. Recheck with `scripts/benchmark_trainer.py` when changing the
model or batch size; it uses checkpoint copies and authored maps.


## Frame history

The policy sees four consecutive grayscale images at 80 by 64 pixels and acts
every simulated 16.7 ms. The oldest and newest images are about 50 ms apart;
there is no four-frame action delay. This provides short motion and approach
ring cues. The current network has no memory beyond these images and no audio
input. Four frames are a baseline, not evidence of sufficient context for hard
osu! maps. A recurrent policy needs a separate real-map comparison before
changing the live model's architecture and checkpoint format.
