# Pi deployment

Version 0.2.0 was installed as Home Assistant app `local_osu_rival` on the Pi 5
on 2026-10-09. Its ingress UI is available through Home Assistant. The separate
private osu! server was updated to 0.10.8 with the cache-only map export.

The trainer copied 100 existing cached maps without errors or upstream requests.
They contain 16,394 circles, 12,667 sliders and 98 spinners. Original `.osu` files
persist with parsed geometry in the app's private `/data/maps` directory.

The worker started from random weights. Pause, saved-attempt recording and
resume were checked on the Pi. After ten updates, the checkpoint contained
5,120 real-map steps and changed weights. This verifies that the training path
runs and saves; it does not establish improved osu! ability. The checked report
is in `validation/pi-real-maps.json`.

Supervisor measured 6.37% total CPU and about 186 MB for the app during training.
The worker reported 168 MB at a later check, with about 3.7 GB available host
memory and a 47.4°C temperature. Defaults remain 25% of one core and a 512 MB
worker budget. The app was left training on the real maps. `train_on_start` is
false, so use Start training after an app restart.

Validation passed with the pinned Python 3.12 / NumPy / Pillow container on an
actual cached .osu file: 22 gameplay, policy, persistence and API checks. The
separate cache bridge passed four checks in the pinned API image, and eleven
server runner/patch checks passed. Native T3 browser checks covered cache sync,
training, pause, practice playback and responsive layout. The live Pi UI also
showed real slider geometry and saved training progress.

Source backups are under `/share/osu-rival-maintenance` and
`/share/osu-server-maintenance` on the Pi. The source update replaced only the
new Rival app and the reviewed server cache-route overlay. Player data and
existing server features were preserved.

Native osu! multiplayer and leaderboard submission remain unimplemented. The
training judge approximates slider and spinner scoring and is not authoritative.


## Practice field scale, 0.2.1

Deployed on 2026-10-09 with a guarded six-file overlay. The active 512 by 384
playfield now fits inside a padded 16:9 arena. At the same panel width, objects
appear 40% smaller. Cursor input, playback and the pixel view share the same
viewport transform. Desktop and mobile browser checks verified field corners
and an interior cursor position, with no horizontal overflow. The deployed
HTML, JavaScript and CSS hashes match the checked source. Saved progress was
retained at 17,408 steps and training remained paused.

Source backup:
`/share/osu-rival-maintenance/before-field-scale-20261009-005043`.

## Learner observation margin, 0.2.2

Deployed on 2026-10-09. The old 64 by 48 observation covered the playable field
but clipped graphics crossing its boundaries. The actual learner input is now
80 by 64, with an eight-image-pixel margin on each side. Its playable field
retains the same pixel density. The new visible coordinates are -64 to 576
horizontally and -64 to 448 vertically. Circle and slider bodies in all 100
cached maps fit within those bounds. Large early approach rings can still
extend beyond the image.

The checkpoint was migrated by copying its convolution and action/value
weights and placing the old dense weights in the corresponding central feature
cells. New surrounding dense weights start at zero. Adam moments and optimizer
step were retained. The live migrated checkpoint was compared against the
original: weights and optimizer match exactly after expansion, with 24,576
training steps and 48 updates retained. Original checkpoints and previous
evaluation history remain backed up in the private models directory. Comparison
signatures now include the observation version so earlier best scores are not
compared with results using the expanded image.

All 25 checks passed locally and in the pinned Python 3.12 container using an
actual cached beatmap. Native browser checks covered the full image on the Pi,
desktop/mobile field coordinate mapping and horizontal overflow. Deployed HTML
and JavaScript match the checked source. Saved attempts completed without
training updates; the app remains paused, matching its state before deployment.
Verification details are in `validation/pi-observation-padding.json`.

Source backup:
`/share/osu-rival-maintenance/before-observation-padding-20261009-010709`.

## Complete training maps, 0.2.3

Deployed on 2026-10-09. The six-second curriculum and 65% accuracy gate were
removed. Each training run contains every authored object in its map. The
learner cycles through complete training maps in difficulty order, advancing
after the final judgment regardless of accuracy. PPO still updates every
512 steps and continues the current run between updates. Active-object lists
keep judging, rendering and live snapshots bounded by visible objects.

The model checkpoint has a matching private `models/latest-run.json` sidecar
containing the map position, judgments, slider/spinner state and image stack.
The sidecar is tied to the checkpoint SHA-256. Graceful pause and restart retain
the run; importing a checkpoint starts a fresh run. The original model from
before this change is retained as `before-full-maps.npz`. The loaded library
has 80 full training maps and 20 withheld maps. Evaluation continues to use
short sections of withheld maps. With a single map, no independent test
accuracy is reported.

All 28 tests passed locally and in the pinned Python 3.12 container on actual
cached beatmaps. The Pi resumed the same map from 17.08 seconds to 25.62 seconds
after a pause. It then finished all 40 objects in No title [Irre's Beginner]
and advanced to Leave The Lights On (KROT Remix) [BounceBabe's Easy], with
120 objects. This verifies full-map traversal, rotation and persistence, not
improved native osu! ability. The checkpoint retains 30,208 training steps,
59 updates and one completed full map. The app remains paused, matching its
state before the update. Validation details are in `validation/pi-full-maps.json`.

Native browser checks verified full-map progress text and desktop/mobile
layout without horizontal overflow. Deployed HTML and JavaScript match the
reviewed source. Resource defaults remain 25% of one CPU core and 512 MB;
the worker used about 185 MB during the Pi verification.

Source backup:
`/share/osu-rival-maintenance/before-full-maps-20261009-012941`.


## Workstation training and model library, 0.4.2

The remote-training branch was merged into current main. The Pi remains the
control and checkpoint hub; the Linux workstation runs eight environments across
four processes, limited to four CPU cores. Training uses the same 100 cached
real beatmaps and does not access player replays. The workstation measured about
1,100 steps per second. This measures throughput, not improvement in gameplay.

The model library can create, select and discard independently saved models.
Creating or selecting a model pauses training first. Weights, Adam state,
random state, evaluation and map positions stay with that model. The Pi rejects
remote uploads for an obsolete model generation. The original model remains
saved, and creating a fresh model does not replace its progress.

The enabled workstation user service is `osu-rival-trainer.service`. Its private
data and hub token are under `~/.local/share/osu-rival-trainer`. The service
connects to the Pi's authenticated port 8100 and follows Start/Pause in ingress.
Parallel views report each run's actual playfield at rollout boundaries. They
remain still during optimization and when paused.

All 49 checks passed in the pinned runtime. Live Pi verification confirmed eight
different cached maps and valid saved positions after pausing during a rollout.
The Pi and workstation checkpoint hashes match. The original model retains
57,856 steps and 86 updates, with the original and app left paused. The report
is in `validation/pi-remote-models.json`.

A pause during the initial 0.4.1 live check exposed an outstanding-reply bug.
The fix drains worker replies before saving. Current weights and primary map
position were preserved; six secondary positions were recovered from the last
valid save, and the overlapping secondary map was reassigned once.

Source backup: `before-parallel-views-20261009-030841` under the maintenance
directory.


## Dedicated bot profile links, 0.5.0

Models can store a verified dedicated bot account ID, its private server address
and website profile link. Regular player accounts and the built-in notification
bot cannot be selected or linked through the API. Profile metadata stays with
each model across switches and restarts. Linking or unlinking leaves training
control, weights and the remote model generation unchanged.

The live server currently has two regular player accounts and its notification
bot, so there are no eligible rival profiles yet. No live model was associated
with a player account. The local preview association used while checking the
form was removed. A dedicated bot profile is required before linking on the Pi.
Account creation, native login, multiplayer joining and authoritative score
submission remain future work.

All 53 pinned checks passed before the account restriction. The four profile
checks passed again in the pinned image with the restriction, covering rejection
of ordinary users, reserved users and unknown IDs, persistence and unchanged
training state. Native browser checks verified the form and mobile layout.


## Pi fallback retains parallel runs, 0.5.1

The Pi trained alone while the workstation service was offline during deployment.
The primary run and learned weights continued, but the earlier single-run worker
removed the waiting parallel sidecar. A Pi-only checkpoint now advances the
primary saved run and keeps every waiting workstation run for its next session.
A pinned test checks this transition without restarting the secondary maps.

A fresh workstation rollout after deployment creates the current eight-run
snapshot from the continued model. Earlier primary progress and weights are
retained. Bot-only profile restrictions remain unchanged.

The final 0.5.1 runtime passed all 54 pinned checks. Live verification confirmed
eight different map views, eight valid saved runs, matching Pi/workstation
checkpoint hashes and 60,928 retained steps across 90 updates. Both ordinary
player accounts received HTTP 400 when a link was attempted; weights, training
counters and model generation remained unchanged. There are zero linked models.
The workstation service remains attached and the app is paused. Details are in
`validation/pi-bot-profiles.json`.

Source backup: `before-pi-run-preservation-20261009-032414`.

## Learning feedback and broader evaluation, 0.6.0

The screenshot's checkpoint contained 541,184 steps and 559 updates. Its weights
and Adam state had changed, but withheld accuracy remained weak. A paired offline
comparison started both variants from that exact checkpoint and identical fresh
whole-map runs, using eight environments across four processes on the same 80
training maps. No player replays or generated maps were used.

After 200 updates and 204,800 steps each, score rewards alone reached 8.57%
accuracy; bounded aim-progress feedback reached 10.30%. Evaluation used 12 real
withheld sections, 199 objects with each of three fixed action seeds. This is
one training seed, not three independent training replications. At 100 updates
the feedback variant was 10.78%, so improvement was not monotonic. The results
support a small experimental gain, not strong native osu! ability. The full
report is `validation/learning-feedback.json`. Experimental checkpoints were
not installed into the model library.

Training now adds discounted potential change from the cursor's distance to
visible unfinished objects. Actual hit/miss judging is unchanged. Positions
stay in the reward engine; the policy receives the same four pixel frames.
Tests verify identical pixels and judgments for the same actions, and that
hovering cannot earn extra discounted return through a complete missed run.

The app now evaluates eight withheld sections with three fixed seeds every
50 updates, plus the first update after changing evaluation methods. Evaluation
uses raw judgments without aim feedback. The chart displays only results from
the latest evaluation method while retaining earlier points in the checkpoint.
The live expanded comparison gave 6.45% accuracy versus its initial model's
6.38% on 162 objects and 486 judgments. This was after the first new update,
not the separately trained 200-update experiment.

All 59 tests passed in the pinned runtime with actual cached map fixtures.
Version 0.6.0 was deployed with a guarded ten-file source overlay. The source
backup is `before-learning-feedback-20261009-035935` under the Pi maintenance
directory. The original checkpoint was retained byte for byte through the
upgrade and separately backed up before live verification.

Live verification ran thirteen complete updates, then paused. The checkpoint
contains 554,496 steps and 572 updates. Every parallel run was saved; seven
continued the same maps and one finished and advanced by its configured stride.
The Pi and workstation checkpoint hashes match. Workstation service restart
reattached without changing progress or starting training. The active model
has no server profile link. Desktop and mobile checks found no horizontal
overflow and confirmed the separate evaluation series. Details are in
`validation/pi-learning-feedback.json`.


## Default lazer rule ports, 0.7.0

Deployed to `local_osu_rival` and the Linux workstation on 2026-10-09. The
trainer and browser practice judge now share the ported default lazer input,
slider, stacking and spinner rules. The live view records actual tracking and
spin state, and the dashboard reports slider parts held separately from heads.

All 71 pinned-container checks passed using an authored .osu fixture. Python
and JavaScript matched across three real maps, 20,510 steps, 1,383 judgment
events and 63 live-view intervals. These are checks of the ports against one
another and upstream unit vectors, not a full native-client comparison.

The app rebuilt 100 parsed caches from unchanged original .osu files. The PC
downloaded all 100; their JSON digests match the Pi. The upgrade retained the
latest checkpoint, initial checkpoint and parallel sidecar byte for byte
before resuming. Eight saved playheads continued under the new rules. Past
component accuracy cannot be reconstructed, so scores on maps already in
progress count only new judgments. Subsequent maps and withheld checks use
complete new scoring.

Live verification advanced the existing model from 559,616 steps and 577
updates to 573,952 steps and 591 updates with eight environments on four
processes. Training is paused. The first new withheld check measured 5.82%
accuracy against a 5.98% initial baseline, with 11.27% of slider parts held.
This establishes that the new judge runs and saves; it does not establish
improved play. Old evaluation records remain preserved but are excluded from
the current chart. No personal account is linked.

A fresh full-map Watch attempt contained 40 authored objects and 4,434 input
frames. Replaying those inputs through the browser judge matched all accuracy
points, the maximum, hits and combo. Watch left both the checkpoint and all
eight saved training runs unchanged. Desktop and mobile browser checks showed
no horizontal overflow or app error. Reports are in
`validation/lazer-rules-parity.json` and `validation/pi-lazer-rules.json`.

Source backup:
`/share/osu-rival-maintenance/before-lazer-rules-20261009-045420`.

The port targets default unmodified lazer with 60 Hz input and sampled curves.
Audio, health/failure, mods and authoritative leaderboard scoring remain
outside this practice app. Upstream source and MIT attribution are included
in `THIRD_PARTY_NOTICES.md` and the downloadable trainer package.


## Workstation controls and optional GPU, 0.8.0

Deployed to the Pi and Linux workstation on 2026-10-10. Trainer settings now
control CPU process count, parallel run count and CPU/GPU mode through ingress.
Settings persist separately from models. Reconfiguration checkpoints the
current model and regrouped runs; disabled runs remain saved for later.

The workstation's Radeon RX 9070 XT runs AMD PyTorch 2.8.0 with ROCm 7.0.2 in
the rootless trainer container, using the existing host driver. The 11.7 GB
runtime is mounted read-only outside the image, with device access limited to
kfd and the render device. Home Assistant protection remains enabled. The
service ceiling is sixteen logical cores; the selected process count controls
the workload beneath that ceiling. GPU mode batches inference across runs and
uses fused Adam, while CPU shards simulate and render authored maps.

All 75 tests passed in Python 3.12, including CPU/GPU numerical parity with
non-zero optimizer state, GPU training/pause and saved-run preservation across
core/run count changes. The alternating four-core/eight-run comparison measured
1,160 steps/s on CPU and 1,057 on GPU. GPU support works, but CPU remains the
default for this network. The workstation had an active desktop/game workload;
these values do not measure isolated hardware capacity.

Live ingress checks changed two cores to four during training. The user then
selected six CPU cores and eight runs; those settings and active training were
preserved. The model reached 2,272,768 steps and 2,250 updates at the final
snapshot, with eight valid paired saved runs and the unchanged initial model.
No model has a profile link. Desktop and 390 px mobile layouts had no horizontal
overflow. The report is `validation/workstation-gpu.json`.

Source backup:
`/share/osu-rival-maintenance/before-trainer-resources-20261010-014025`.
