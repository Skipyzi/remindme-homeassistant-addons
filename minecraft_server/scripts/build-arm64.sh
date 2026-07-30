#!/usr/bin/env bash
# Build the add-on image for aarch64 (default) or another supported architecture.
#
# The Home Assistant builder does the same thing on the device; this script exists
# so the image can be verified on a workstation before publishing.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"

arch="${1:-aarch64}"
case "$arch" in
  aarch64) platform="linux/arm64" ;;
  amd64)   platform="linux/amd64" ;;
  *) echo "unsupported architecture: $arch (use aarch64 or amd64)" >&2; exit 1 ;;
esac

version="$(grep -E '^version:' "$root/config.yaml" | head -1 | cut -d'"' -f2)"
base="$(grep -A3 '^build_from:' "$root/build.yaml" | grep "  $arch:" | awk '{print $2}')"
tag="local/minecraft-addon-$arch:${version:-dev}"

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is required (it provides cross-architecture builds)" >&2
  exit 1
fi

if [[ "$platform" != "linux/$(docker version --format '{{.Server.Arch}}')" ]]; then
  echo "==> registering qemu emulators for cross-architecture builds"
  docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null
fi

echo "==> building $tag for $platform from $base"
docker buildx build \
  --platform "$platform" \
  --build-arg "BUILD_FROM=$base" \
  --build-arg "BUILD_ARCH=$arch" \
  --build-arg "BUILD_VERSION=${version:-dev}" \
  --tag "$tag" \
  --load \
  "$root"

echo
echo "==> image contents"
docker run --rm --platform "$platform" --entrypoint /bin/sh "$tag" -c '
  set -e
  echo "controller: $(/usr/bin/mc-controller --help 2>&1 | head -1 || echo present)"
  echo "java:       $(java -version 2>&1 | head -1)"
  echo "restic:     $(restic version 2>&1 | head -1)"
  echo "plugin:     $(ls -l /opt/minecraft/assets/mcbridge.jar | awk "{print \$5\" bytes\"}")"
  echo "frontend:   $(ls /opt/minecraft/frontend | tr "\n" " ")"
  echo "presets:    $(ls /opt/minecraft/assets/presets | tr "\n" " ")"
'

echo
echo "built $tag"
