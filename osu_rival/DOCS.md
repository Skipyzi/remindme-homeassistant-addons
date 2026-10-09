# Using osu! Rival

Open the app in Home Assistant and press **Start training**. It copies real
beatmaps already cached by your osu! server, then learns from its own inputs and
rewards. It never reads player replays or generates training maps.

If the cache is empty, use **Import .osu map** to add an original osu!standard
beatmap file, or open a map in your server's Finder before syncing again.
Imported maps become training data when the worker next starts. Pause and use
**Sync server cache** to add newly cached maps. Copies remain saved even after
the server's Redis cache expires.

The app plays complete training maps in order of difficulty, then cycles through
them again. It finishes the map even if it misses every object. Accuracy does
not lock it to a section. Circles, sliders and spinners retain their authored
positions and timing. Learning updates continue during the run without
restarting the map. The field shows elapsed time and how many objects have been
judged. Full maps completed counts attempts since full-map training was added.

Evaluation checks short sections from withheld maps. With only one saved map,
no independent test accuracy is shown. Add another real map to enable it.
The model receives four 80 × 64 grayscale images. They include the full
512 × 384 playfield and a 64 game-pixel margin on every side, at one image pixel
per eight game pixels. The learner view shows this whole input image.

Upgrading from the earlier 64 × 48 input retains trained weights, optimizer
state and training steps. The original checkpoints are kept as
`before-padding.npz` and `initial-before-padding.npz`. Earlier evaluation
results are archived, and comparisons are recomputed with the expanded view.

The model and current map position save after each update and on graceful pause.
Resume continues from the saved position. A checkpoint imported from another
installation starts a fresh map, while retaining its learned weights. Press **Pause training** whenever you need the
Pi's resources. Restarting keeps the model; `train_on_start` resumes automatically
if enabled in app configuration. Pause before importing a checkpoint. Only
checkpoints trained with the real-beatmap version are accepted.

**Watch an attempt** records the learner on a complete current map or selected map.
**Play against it** lets you play the same local map. Move the cursor and use
Z/X or the mouse. Hold a key while following sliders or rotating on spinners.
The practice renderer and judge are approximate and have no audio.

These local challenges are not osu! multiplayer matches. Native game connection
and leaderboard submission are still pending. The app writes no server scores.

## Training on another computer

A faster PC on your network can do the training. In the app configuration, turn on `remote_training` and keep port
8100 mapped in the app's Network settings. Restart the app, then open **Train on another computer** in the app: it
shows two commands with your hub token. Run them on the PC (Python 3.10 or newer with numpy and Pillow):

```
curl -fsS -H "Authorization: Bearer TOKEN" http://HOME-ASSISTANT:8100/remote/v1/trainer.py -o rival-trainer.py
python3 rival-trainer.py --hub http://HOME-ASSISTANT:8100 --token TOKEN
```

The trainer downloads the app's own code, maps and latest model, takes over from local training and trains with
half of the PC's cores at low priority (choose with `--processes N`). Start, Pause and Watch in the app control it,
and the app shows its live field and progress. Ctrl+C on the PC stops it; the latest model is already saved in the
app. Set `remote_token` to choose the token yourself, or leave it empty to have one generated and kept.

## Resource limits

The default worker uses one thread and 25% of one CPU core, with a 512 MB memory
budget. It waits below 768 MB available host memory or above 75°C, then resumes
when conditions recover. The CPU budget is a duty-cycle limit. Home Assistant
and other apps share the Pi.

Errors pause training and appear in the UI. The last completed checkpoint stays
saved. `beatmap_server_url` defaults to `http://local-osu-server:8087`.
