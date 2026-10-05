# Forgejo storage dashboard

A Home Assistant sidebar dashboard for the local Forgejo add-on. It shows allocated
disk usage for Git repositories, LFS, the database, attachments, package storage,
archives, Actions data, logs and remaining files. It also shows the ten largest
repositories, free disk space and a 72-hour history graph.

The collector runs inside Forgejo and scans `/data` every ten minutes. It only reads
file metadata and selected paths from `app.ini`. It never invokes Git, runs hooks,
changes a repository or exports credentials. It writes an atomic, private report at
`/share/forgejo/storage.json`. Home Assistant reads that file every minute. Failed
scans and reports older than thirty minutes make the sensors unavailable.

## Installation

Back up the Forgejo add-on and Home Assistant configuration first. Copy this
directory to the Home Assistant SSH add-on. Run as root:

```sh
python3 install.py --addon /addons/forgejo --homeassistant /config
```

The installer preserves the customized Forgejo image, adds Python and the collector,
maps the shared folder, and increments the local add-on version once when the
collector changes. It copies the sensor package and dashboard into Home Assistant
and registers an admin-only **Version control** panel at `/version-control/storage`.

Reload the Supervisor add-on store and update the local Forgejo add-on to build the
new image. Check Home Assistant configuration, then restart Home Assistant. These
steps require the SSH add-on's Supervisor token in its environment; don't copy the
token into any file or chat. The initial setup requires a Home Assistant restart.

The installer stops before writing if `homeassistant:` or `lovelace:` already exists,
or a populated packages directory needs review. Merge these additions into existing
configuration instead, keeping the current dashboard mode and other settings:

```yaml
homeassistant:
  packages: !include_dir_named packages

lovelace:
  dashboards:
    version-control:
      mode: yaml
      title: Version control
      icon: mdi:source-repository
      show_in_sidebar: true
      require_admin: true
      filename: dashboards/version-control.yaml
```

After a manual merge, add `# Forgejo storage monitoring` above these settings so the
installer recognizes that they have been handled. Existing package includes must
include `packages/forgejo_storage.yaml`. If packages are already configured through
another mechanism, add that package there instead.

## What the measurements include

The total is persistent Forgejo `/data`, including directory metadata. Sparse files
use their allocated blocks. Hardlinks count once for the whole report, attributed
to the first path in alphabetical traversal order. Repository rows show Git data;
shared LFS objects appear separately. Wiki repositories are included in the count.

Container images, separate runner workspaces, backups and external object storage
are outside the Forgejo total. The free-space sensor and disk gauge describe the
filesystem hosting `/data`, shared by other services on Home Assistant OS.

The collector respects local absolute repository and storage paths inside `/data`.
It rejects unsupported external paths and object storage instead of reporting a
misleading zero. Symlinks are measured as links and never followed. Busy repository
files that disappear during a scan are skipped; unreadable data fails the scan.
Existing Home Assistant recorder exclusions can affect the history graph.

## Validation

```sh
python3 -m unittest discover -s deployment/forgejo-storage/tests -v
```

Tests compare the breakdown against `du`, check sparse files, hardlinks and external
symlinks, custom and overlapping storage paths, unavailable storage, private atomic
report replacement, installer idempotency and safe config merge refusal.

To remove the panel, remove its dashboard entry and sensor package, then check and
restart Home Assistant. To remove the collector, delete its two startup lines from
Forgejo `run.sh`, rebuild the local add-on and remove the shared report. Restore the
saved add-on source and HA configuration to undo the complete installation.
