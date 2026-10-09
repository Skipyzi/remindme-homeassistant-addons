# 0.5.1

- Preserve waiting workstation runs when the Pi trains alone between PC sessions.

# 0.5.0

- Link each saved model to an existing dedicated bot profile on the private osu! server.
- Keep the account ID and profile link with the model across switches and restarts.
- Show the active model's server profile and allow changing or removing the link.

# 0.4.2

- Show all parallel training playfields, map names and full-map progress.
- Offset new runs from the primary map so they start on different cached maps.
- Drain subprocess replies when pausing mid-rollout so every run can resume.

## 0.4.1

- Wait for the PC's final saved pause before archiving a running model.
- Reject an incomplete checkpoint/run transfer when creating or switching models.

## 0.4.0

- Add named models: create a fresh model, select saved progress, or discard a model from the panel.
- Keep weights, optimizer, evaluation history and every full-map run separate for each model. Beatmaps stay shared.
- Pause and save before switching models; reject uploads from a PC using an earlier model selection.

## 0.3.1

- Preserve every parallel environment and its action generator on pause and resume.
- Pause the PC on lost hub contact; require its owning session for control heartbeats.
- Synchronize maps and imported models before restarting a paused PC trainer.
- Upload saved models before reporting the final paused state.
- Support a private token file for a managed PC trainer service.

## 0.3.0

- Train on another computer: turn on `remote_training` and run the trainer on a faster PC (the app shows the
  command). The PC downloads the maps and model, trains with its own cores, and sends checkpoints, progress and
  the live field back, so the app shows it like local training. Start, pause and watch still work from the app.
  It takes over from local training automatically, uses half the PC's cores at low priority by default, and every
  request needs the hub token.
- Parallel training: several environments in several processes share the network's weights and learn in one PPO
  update. Off on the Pi (`parallel_envs: 1`); the remote trainer uses two environments per process.
- The live field follows the cursor's real path between snapshots (`trail` in the live scene).
- New web UI: one large practice field with an in-game style HUD, smooth live view, Watch and Play against it in one
  bar, a searchable map list, and an Inside the model section.

## 0.2.3

- Train on complete real maps and cycle through training maps without an accuracy gate.
- Keep small PPO updates during each map; preserve the playhead, judgments and image stack on pause and resume.
- Show elapsed map time, judged object counts and completed full maps.
- Render and judge only active objects to keep full-map runs inexpensive. Evaluation still uses bounded sections from withheld maps.

# 0.2.2

- Expand the learner observation to 80 by 64 pixels, retaining the original field resolution and adding a 64 game-pixel margin on each side.
- Show the entire observation in the learner view and keep the normal view and mouse coordinates aligned.
- Migrate existing weights and optimizer state to the padded input; retain original checkpoint backups and start fresh evaluation comparisons for the new view.

# 0.2.1

- Fit the practice field inside a wider arena with margins, so objects appear smaller and the field needs less vertical space.
- Use the same scale for cursor input, playback and the learner pixel view.

# 0.2.0

- Train only on real `.osu` beatmaps imported or copied from the server's existing cache.
- Remove the generated curriculum and its benchmark claims.
- Add slider paths, timing points, repeats, checkpoints and spinner rotation rewards.
- Withhold real maps or time sections for evaluation against the original random model.
- Keep one-button training, automatic checkpoints and Pi resource limits.
- Native multiplayer and leaderboard submission remain pending.
