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

Circles use timing and position judgments. Sliders use their declared curves,
timing points, velocity changes, repeats and tracking checkpoints. Spinners use
held keys and cursor rotation. The lightweight renderer and judge are approximate.
They do not reproduce native stacking, health, mods, skin graphics or audio.
Training results cannot authorize leaderboard scores.

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
The checked 200-update comparison reached 10.3% withheld accuracy with aim
feedback versus 8.6% with score rewards alone. This is one training seed, scored
with three action seeds on 12 real sections. Improvement was small and not
monotonic; it does not establish strong native osu! play. Results are in
`validation/learning-feedback.json`.
