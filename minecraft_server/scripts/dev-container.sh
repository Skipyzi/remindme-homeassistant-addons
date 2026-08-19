#!/usr/bin/env bash
# Run the add-on in a local amd64 container - the same bits the Pi runs, minus
# the hardware - with direct API access so a browser at http://127.0.0.1:8099
# can drive it without Home Assistant.
#
#   scripts/dev-container.sh up        build the image and start fresh
#   scripts/dev-container.sh reload    push the current backend + frontend into
#                                      the running container (seconds, no build)
#   scripts/dev-container.sh logs      follow the controller log
#   scripts/dev-container.sh down      stop and remove the container
#
# The container keeps its /data between reloads, so an installed server, worlds
# and backups survive a code push; "down" throws everything away.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
# Git Bash on Windows: docker needs the Windows spelling of the build context,
# while MSYS_NO_PATHCONV keeps the container-internal paths untouched.
ctx="$root"
if command -v cygpath >/dev/null 2>&1; then ctx="$(cygpath -m "$root")"; fi
name="mc-addon-dev"
image="mc-addon:dev"
flavour="${MC_DEV_FLAVOUR:-paper}"

case "${1:-up}" in
up)
  MSYS_NO_PATHCONV=1 docker buildx build --platform linux/amd64 \
    --build-arg BUILD_FROM=ghcr.io/home-assistant/amd64-base:3.23 \
    --build-arg GO_VERSION=1.25 -t "$image" --load "$ctx"
  docker rm -f "$name" 2>/dev/null || true
  MSYS_NO_PATHCONV=1 docker run -d --name "$name" --platform linux/amd64 \
    -p 8099:8099 -p 25565:25565 \
    -e MC_LISTEN=0.0.0.0:8099 -e MC_DATA_DIR=/data -e MC_OPTIONS_FILE=/data/options.json \
    --entrypoint /bin/sh "$image" -c '
      mkdir -p /data
      [ -f /data/options.json ] || cat > /data/options.json <<JSON
{"server_flavour":"'"$flavour"'","server_port":25565,"memory_min_mb":1024,"memory_max_mb":2048,
 "jvm_flags_profile":"balanced","stop_timeout_seconds":60,"chunky_source":"modrinth",
 "allow_direct_access":true,"mqtt_enabled":false,"log_level":"debug"}
JSON
      exec /usr/bin/mc-controller'
  echo "up: http://127.0.0.1:8099 (flavour: $flavour; game port 25565 is mapped too)"
  ;;
reload)
  # Cross-compile the controller on the host and push it plus the frontend into
  # the running container - a full image rebuild is only needed when the
  # Dockerfile or the Java plugin change.
  ( cd "$root/backend" && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/mc-controller-dev ./cmd/controller )
  docker cp /tmp/mc-controller-dev "$name":/usr/bin/mc-controller
  docker cp "$root/frontend/." "$name":/opt/minecraft/frontend/
  docker restart "$name" >/dev/null
  echo "reloaded: controller binary + frontend (data kept). Hard-refresh the browser."
  ;;
logs)
  docker logs -f "$name"
  ;;
down)
  docker rm -f "$name" 2>/dev/null || true
  echo "down: container and its data removed"
  ;;
*)
  echo "usage: $0 up|reload|logs|down" >&2
  exit 1
  ;;
esac
