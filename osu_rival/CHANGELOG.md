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
