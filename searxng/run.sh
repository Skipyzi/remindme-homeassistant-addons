#!/bin/sh
set -eu

# The venv Python from the upstream image; the base has no system python.
/usr/local/searxng/.venv/bin/python /gen-settings.py

# Hand off to SearXNG's own entrypoint. It sees the settings file already
# exists, so it skips its template step and its random-secret injection,
# fixes volume ownership, and launches granian.
exec /usr/local/searxng/entrypoint.sh
