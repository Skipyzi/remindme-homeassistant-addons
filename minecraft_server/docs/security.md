# Security notes

## Threat model

The add-on runs inside Home Assistant OS on a home network. The realistic risks are:

1. A Minecraft player or plugin trying to reach beyond the game.
2. Another device on the LAN poking at the management interface.
3. A malicious or malformed world archive.
4. A hostile download when installing PaperMC or Chunky.
5. Secrets leaking into logs, backups or API responses.

The add-on is not designed to defend against someone who already has root on the host.

## Authentication and the management interface

- Ingress is the primary authentication boundary: Home Assistant authenticates the user and
  proxies the request.
- The controller does not rely on Ingress alone. Every state-changing request must also
  carry `X-Minecraft-Addon: 1`, which a cross-site form post cannot set without a CORS
  preflight.
- Requests that do not arrive through Ingress may read status but never change anything,
  unless the operator sets `allow_direct_access`.
- No port is published for the management interface. Only Minecraft's own port (25565) is
  mapped, and that mapping can be removed.
- Responses set `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and
  `X-Frame-Options: SAMEORIGIN`.

## Confirmation for destructive actions

Force stop, moving a world to the trash, permanent deletion, restoring a backup, deleting a
backup, cancelling generation, installing an update and accepting the EULA all require an
exact typed phrase. They are also all written to the audit log with the actor, which for
Ingress requests is the Home Assistant user name when the proxy provides it.

Home Assistant entities deliberately expose only non-destructive commands.

## Path handling

- Configuration files are reached through a fixed allow-list, never by path from a request.
- Every path that includes user input goes through a confine helper that rejects absolute
  paths, drive letters, traversal segments and NUL bytes, and verifies the result is still
  inside its root.
- World and preset identifiers are restricted to letters, digits, dash, underscore and dot,
  1-64 characters, no leading dot, no reserved names.
- Static files are served from the frontend directory only, resolved through the same
  confine helper.

## Archive imports

World imports are extracted into a staging directory and refused on:

- absolute paths, drive letters or `..` segments (ZIP slip),
- symbolic links, device nodes, sockets or anything that is not a regular file,
- more than 400,000 entries, more than 64 GiB uncompressed, or a per-entry compression
  ratio above 200 (ZIP bombs),
- names longer than 512 characters or nested deeper than 24 levels.

After extraction the tree is walked again and rejected if any non-regular file is present.
Only then is it moved into place, so a rejected archive never leaves a partial world behind.

## Subprocesses

- Every subprocess is executed with an argument array. No user input reaches a shell, and
  no shell is involved at all.
- Minecraft is started with a deliberately small environment: `PATH`, `JAVA_HOME`, `TZ`,
  `LANG`, `HOME`, `TERM`, plus the two bridge variables.
- Custom JVM flags are validated: they must start with `-`, must not contain shell
  metacharacters, and may not set the heap, classpath or `-jar` (those are managed).
- Console commands must be a single line, at most 512 characters, with no control
  characters, so one request cannot inject a second command.

## Telemetry bridge

The `McBridge` plugin does not listen on anything. It dials a Unix domain socket inside
`/data` (mode 0600) that the controller owns, and authenticates with a 32-byte random token
stored in `/data/secrets/bridge.token` (mode 0600). The plugin's first line must present the
token, which is compared in constant time. A rejected handshake is logged and dropped.

RCON is disabled in the default server properties and is not used by the add-on.

## Downloads

- PaperMC builds are downloaded over HTTPS and verified against the SHA-256 published in
  the build metadata. A build without a published checksum is refused.
- Chunky is downloaded from `api.modrinth.com` / `cdn.modrinth.com` only, and verified
  against the SHA-512 in the release metadata. Any other host requires the operator to
  configure both a URL and an expected SHA-256 (`chunky_source: url`).
- Downloads are size limited (32 MB for plugins, 200 MB for server JARs) and checked to be
  actual ZIP/JAR archives before installation.
- Nothing is downloaded without an explicit action. Scheduled updates exist but are off by
  default.

## Secrets

- The restic repository password and the bridge token are generated locally with
  `crypto/rand` and stored with mode 0600 in `/data/secrets`, which itself is 0700.
- Console output, audit entries and API error messages are passed through a redaction pass
  that masks values following `password`, `passwd`, `token`, `secret`, `api_key`.
- The API never returns the MQTT password; it reports `***` when one is set.
- Losing `/data/secrets/restic.pass` makes the backup repository unreadable. Copy it
  somewhere safe - see [backup-recovery.md](backup-recovery.md).

## Supervisor access

The add-on requests `hassio_api` with the `default` role and the `mqtt` service, which is
enough to discover the broker. It does not request host network, host PID, AppArmor
exceptions, Docker access or any device mapping. `/data` is the only mapped volume.

## Reporting a problem

Open an issue in the repository. If it is a security problem, please describe it privately
first rather than in a public issue.
