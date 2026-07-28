#!/bin/sh
set -eu
export PORT=8091
export FILE_EXPLORER_OPTIONS=/data/options.json
export FILE_EXPLORER_DATA=/data/file-explorer
exec node /app/dist/server.js
