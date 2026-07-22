#!/bin/sh
set -eu

PY=/usr/local/searxng/.venv/bin/python

# The venv Python from the upstream image; the base has no system python.
"$PY" /gen-settings.py

# Overlay the RemindMe frontend onto the installed theme. The paths are found
# through the searx package rather than hard-coded, so an upstream move of the
# source tree does not silently drop the custom page. index.html replaces the
# landing template; the assets go under /static/remindme so they load from the
# same origin and satisfy any content-security-policy without a change to it.
SEARX_DIR=$("$PY" -c 'import os, searx; print(os.path.dirname(searx.__file__))')
STATIC_DIR="$SEARX_DIR/static/remindme"
INDEX_TPL="$SEARX_DIR/templates/simple/index.html"

mkdir -p "$STATIC_DIR/fonts"
cp -f /remindme-frontend/app.css /remindme-frontend/app.js "$STATIC_DIR/"
cp -f /remindme-frontend/fonts/*.woff2 "$STATIC_DIR/fonts/"
if [ -f "$INDEX_TPL" ]; then
	cp -f /remindme-frontend/index.html "$INDEX_TPL"
else
	echo "[remindme] landing template not found at $INDEX_TPL; leaving the stock page" >&2
fi
# The upstream entrypoint drops to the unprivileged searxng user, so the files
# it will serve have to be world-readable.
chmod -R a+rX "$STATIC_DIR"
[ -f "$INDEX_TPL" ] && chmod a+r "$INDEX_TPL" || true

# Hand off to SearXNG's own entrypoint. It sees the settings file already
# exists, so it skips its template step and its random-secret injection,
# fixes volume ownership, and launches granian.
exec /usr/local/searxng/entrypoint.sh
