#!/bin/sh
set -eu
mkdir -p /data/models /data/maps
chown rival:rival /data
chown -R rival:rival /data/models /data/maps
exec python -m rival.server --data /data --port 8099
