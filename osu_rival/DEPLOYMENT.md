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
