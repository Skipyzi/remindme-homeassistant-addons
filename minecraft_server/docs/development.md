# Development

## Layout

```text
minecraft_server/
├── config.yaml build.yaml Dockerfile     add-on packaging
├── rootfs/                              s6-overlay service definition
├── backend/                              Go controller (module root)
│   ├── cmd/controller/                   wiring and startup reconciliation
│   └── internal/                         one package per responsibility
├── frontend/                             HTML, CSS and ES modules, no build step
├── paper-plugin/                         McBridge telemetry plugin (Maven, Java 21)
├── presets/                              preset overlays shipped with the image
├── scripts/                              dev, test and ARM64 build helpers
├── tests/                                integration script, fixtures, manual test plan
└── docs/                                 this documentation
```

The backend has no code generation and no build tags beyond platform files
(`*_linux.go`, `*_windows.go`, `*_other.go`), so `go build ./...` is the whole build.

## Prerequisites

- Go 1.25 or newer
- Optional: `restic` on `PATH` to exercise real backups locally
- Optional: JDK 21 and Maven to build the Paper plugin
- Optional: Docker with buildx to build the add-on image

## Running the controller locally

```bash
cd backend
go run ./cmd/controller
```

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MC_DATA_DIR` | `devdata` | Where the `/data` layout is created |
| `MC_FRONTEND_DIR` | `../frontend` | Static files to serve |
| `MC_ASSETS_DIR` | `../` | Contains `presets/` and `assets/mcbridge.jar` |
| `MC_LISTEN` | `127.0.0.1:8099` | Listen address |
| `MC_OPTIONS_FILE` | `/data/options.json` | Add-on options; a missing file means defaults |
| `MC_LOG_LEVEL` | `info` | `debug`, `info`, `warning`, `error` |

Writes require Ingress by default. For local development, point `MC_OPTIONS_FILE` at a file
with `{"allow_direct_access": true}` so `curl` and the browser can change state:

```bash
cat > /tmp/options.json <<'JSON'
{"allow_direct_access": true, "mqtt_enabled": false}
JSON
MC_OPTIONS_FILE=/tmp/options.json MC_FRONTEND_DIR=../frontend MC_ASSETS_DIR=.. \
  MC_DATA_DIR=/tmp/mcdata go run ./cmd/controller
```

`scripts/dev.sh` does this for you.

Two things do not work outside Linux:

- The telemetry bridge needs a Unix domain socket path the platform accepts; on Windows the
  controller logs a warning and continues without TPS and heap values.
- Disk statistics come from `statfs`; elsewhere free space reads as unknown, and terrain
  generation refuses to start rather than assuming there is room.

## Tests

```bash
cd backend
go test ./...              # unit and integration tests
go test -race ./...        # the supervisor and managers are concurrent
go vet ./...
```

Paper and restic are replaced by real processes that speak their protocols:

- `internal/testsupport/fakepaper` prints the console grammar the supervisor parses and
  obeys `stop`, `save-off`, `save-all`, `save-on` and `chunky` commands. `FAKEPAPER_MODE`
  selects `ready`, `crash_start`, `crash_late`, `no_ready` or `ignore_stop`.
- `internal/testsupport/fakerestic` implements `init`, `backup`, `snapshots`, `ls`,
  `restore`, `forget`, `check` and `stats` with real deduplication accounting, so the
  incremental-backup test measures something meaningful. `FAKERESTIC_FAIL` forces a failure
  in `backup`, `restore` or `check`.

Both are compiled on demand by `testsupport.FakeBinary`, which skips the test if no Go
toolchain is available.

What the suite covers: atomic writes and directory swaps, configuration validation and
snapshots, YAML editing that preserves comments, preset diff and override handling, world
creation, cloning, ZIP-slip and symlink rejection, layout normalisation, world-switch
rollback, supervisor lifecycle including stop-timeout escalation and crash classification,
lease exclusivity, live backup consistency and the guarantee that saving is re-enabled after
a failure, restore rollback, interrupted-operation recovery, generation guards with
hysteresis and the empty-server delay, storage estimation from region headers, low-disk
cancellation, job reconciliation, MQTT command mapping and discovery payloads, Ingress and
CSRF rules, and static-file confinement.

## Building the Paper plugin

```bash
cd paper-plugin
mvn -B package
# target/mcbridge-1.0.0.jar
```

The plugin only uses `paper-api` (provided scope) and the JDK, so the jar is a few kilobytes
and shades nothing.

## Building the add-on image

```bash
scripts/build-arm64.sh          # aarch64, needs docker buildx and qemu
scripts/build-arm64.sh amd64    # for a local x86 test
```

The Dockerfile has three stages: the Go controller (pure Go, `CGO_ENABLED=0`, so
cross-compilation is a matter of `GOARCH`), the Maven plugin build, and the Home Assistant
Alpine base with `openjdk21-jre-headless` and `restic`.

To test the real add-on in Home Assistant, add the repository as a local add-on:

```bash
# On the Home Assistant host, in /addons
git clone https://github.com/skipyzi/remindme-homeassistant-addons local-addons
```

Then reload the add-on store; the add-on appears under "Local add-ons" and is built on the
device.

## Adding another server flavour

`internal/adapter` defines the whole contract: argv construction, console grammar,
save/stop commands, generation commands, editable files, default properties and the EULA
file content. `internal/adapter/paper` is the only implementation. A PumpkinMC or Fabric
backend means adding a package there and selecting it in `cmd/controller`; the supervisor,
world, backup and generation managers do not change.

## Conventions

- No shell strings for subprocesses; always an argument array.
- Filesystem changes go through `internal/atomicfs`; nothing writes a destination file
  directly.
- Multi-step operations open a journal row before their first side effect.
- Anything a user can trigger that changes state is audited.
- Comments explain why a decision was made, not what the line does.
