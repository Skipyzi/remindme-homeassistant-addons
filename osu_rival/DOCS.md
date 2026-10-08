# Using osu! Rival

Open the app in Home Assistant and press **Start training**. It copies real
beatmaps already cached by your osu! server, then learns from its own inputs and
rewards. It never reads player replays or generates training maps.

If the cache is empty, use **Import .osu map** to add an original osu!standard
beatmap file, or open a map in your server's Finder before syncing again.
Imported maps become training data when the worker next starts. Pause and use
**Sync server cache** to add newly cached maps. Copies remain saved even after
the server's Redis cache expires.

The app automatically chooses short, consecutive sections of easier maps.
Circles, sliders and spinners retain their authored positions and timing.
Practice expands as accuracy improves. The progress chart compares the trained
model with its original random weights on withheld real maps or time sections.
The model receives only four small images, without target coordinates.

Progress saves after each update. Press **Pause training** whenever you need the
Pi's resources. Restarting keeps the model; `train_on_start` resumes automatically
if enabled in app configuration. Pause before importing a checkpoint. Only
checkpoints trained with the real-beatmap version are accepted.

**Watch an attempt** records the learner on a real section or selected full map.
**Play against it** lets you play the same local map. Move the cursor and use
Z/X or the mouse. Hold a key while following sliders or rotating on spinners.
The practice renderer and judge are approximate and have no audio.

These local challenges are not osu! multiplayer matches. Native game connection
and leaderboard submission are still pending. The app writes no server scores.

## Resource limits

The default worker uses one thread and 25% of one CPU core, with a 512 MB memory
budget. It waits below 768 MB available host memory or above 75°C, then resumes
when conditions recover. The CPU budget is a duty-cycle limit. Home Assistant
and other apps share the Pi.

Errors pause training and appear in the UI. The last completed checkpoint stays
saved. `beatmap_server_url` defaults to `http://local-osu-server:8087`.
