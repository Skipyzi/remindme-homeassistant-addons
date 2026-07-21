#!/bin/sh
# Compile what is COMMITTED, not what sits in the working tree.
#
# v2.17.1 shipped a harness-server.ts importing ./harness/artifacts with no
# such module beside it: a selective `git add` staged the importer and left
# the imported file behind. The working tree compiled fine, so nothing local
# caught it — the add-on build failed on the Pi with TS2307 instead.
#
# Run this before pushing, especially after a partial `git add`.
#
#   sh scripts/verify-commit-builds.sh [ref]
set -eu
REF="${1:-HEAD}"
ROOT="$(git rev-parse --show-toplevel)"
OUT="$ROOT/.buildcheck-$$"
trap 'rm -rf "$OUT"' EXIT
mkdir -p "$OUT"
# Extracted from the object store, so only committed content is compiled.
git archive "$REF" discord-pi-bot | tar -x -C "$OUT"
cd "$OUT/discord-pi-bot"
npx tsc --noEmit
echo "$REF compiles clean"
