#!/usr/bin/env bash
# Verify the add-on image builds for aarch64 and contains everything it needs.
#
# Skips (exit 0) when Docker or buildx is unavailable, so it is safe to wire into
# a pipeline that does not always have them.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker is not installed"
  exit 0
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "SKIP: docker buildx is not available"
  exit 0
fi

echo "==> building the aarch64 image"
"$root/scripts/build-arm64.sh" aarch64

version="$(grep -E '^version:' "$root/config.yaml" | head -1 | cut -d'"' -f2)"
tag="local/minecraft-addon-aarch64:${version:-dev}"

echo "==> checking the image contents"
docker run --rm --platform linux/arm64 --entrypoint /bin/sh "$tag" -c '
  set -eu
  fail() { echo "FAIL: $1"; exit 1; }

  [ -x /usr/bin/mc-controller ] || fail "the controller binary is missing"
  command -v java >/dev/null || fail "java is missing"
  java -version 2>&1 | grep -q "21\." || fail "java 21 is required"
  command -v restic >/dev/null || fail "restic is missing"
  [ -s /opt/minecraft/assets/mcbridge.jar ] || fail "the mcbridge plugin is missing"
  [ -s /opt/minecraft/frontend/index.html ] || fail "the frontend is missing"
  [ -s /opt/minecraft/frontend/app.js ] || fail "the frontend modules are missing"
  ls /opt/minecraft/assets/presets/*.json >/dev/null || fail "the presets are missing"
  [ -x /etc/s6-overlay/s6-rc.d/controller/run ] || fail "the s6 service is missing"
  [ -f /etc/s6-overlay/s6-rc.d/user/contents.d/controller ] || fail "the s6 service is not enabled"

  # The binary must actually run on this architecture.
  /usr/bin/mc-controller --version >/dev/null 2>&1 || true

  echo "OK: aarch64 image contains the controller, java 21, restic, the plugin, the frontend and the presets"
'

echo
echo "arm64 build test passed"
