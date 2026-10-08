# osu! Rival

A small Home Assistant app that learns osu!standard from pixels and rewards on
real beatmaps. It runs one NumPy worker on a Raspberry Pi 5. Player replays and
pretrained weights are never used.

Press **Start training**. With an empty map library, the app copies `.osu` files
already cached by the private osu! server. It makes no upstream requests. You
can also import an original `.osu` file. All saved maps can participate in
training after the worker next starts. There is no generated-map fallback.

The model sees four 64 × 48 grayscale frames. It chooses the cursor position
and the Z/X key state. A small PPO implementation updates its roughly 37,000
parameters using judgments from its own actions. Only the environment reads the
beatmap coordinates and timing; these values never enter the policy.

Training begins with an easy, consecutive section of a real map. It expands
the selection after ten sufficiently accurate attempts. Sections preserve the
map's coordinates, timing, difficulty and object types. Boundaries do not cut
sliders or spinners. Evaluation uses withheld maps when multiple maps exist,
or withheld time sections with a single map. If no independent section exists,
the app does not report a test accuracy.

Circles use timing and position judgments. Sliders use their declared curves,
timing points, velocity changes, repeats and tracking checkpoints. Spinners use
held keys and cursor rotation. The lightweight renderer and judge are approximate.
They do not reproduce native stacking, health, mods, skin graphics or audio.
Training results cannot authorize leaderboard scores.

The app saves after each completed update. Start and Pause are the training
controls. It defaults to one thread, 25% of one CPU core, and a 512 MB worker
memory limit. It waits when available host memory is below 768 MB or the Pi is
above 75°C. These are resource guards, not a hard container CPU quota.

**Watch an attempt** records the saved model on a real training section or a
selected full map. **Play against it** is a local browser practice challenge.
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
OPENBLAS_NUM_THREADS=1 python3 scripts/benchmark_learning.py --maps /tmp/osu-rival/maps --updates 20
```

No improvement on full osu! maps has been established yet. A learning run must
be judged against the saved random model on withheld real maps. Longer training
may be necessary, and strong play from random initialization is not guaranteed.
