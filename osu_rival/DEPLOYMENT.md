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
