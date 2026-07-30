#!/usr/bin/env bash
# Full check: vet, unit and integration tests, and the frontend syntax check.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"

echo "==> go vet"
(cd "$root/backend" && go vet ./...)

echo "==> go test"
race=()
if [[ "${MC_TEST_RACE:-1}" == "1" ]] && go env CGO_ENABLED >/dev/null 2>&1; then
  # -race needs cgo; skip it silently where that is unavailable.
  if [[ "$(go env CGO_ENABLED)" == "1" ]]; then
    race=(-race)
  fi
fi
(cd "$root/backend" && go test "${race[@]}" ./...)

echo "==> frontend syntax"
if command -v node >/dev/null 2>&1; then
  # The container ships no Node; this is only a developer convenience check.
  for file in "$root"/frontend/*.js "$root"/frontend/views/*.js; do
    node --check "$file"
  done
  echo "checked $(ls "$root"/frontend/*.js "$root"/frontend/views/*.js | wc -l) modules"
else
  echo "node not installed, skipping the frontend syntax check"
fi

echo "==> preset files"
(cd "$root/backend" && go test ./internal/presets/ -run TestShippedPresetFilesAreValid -count=1)

echo
echo "all checks passed"
