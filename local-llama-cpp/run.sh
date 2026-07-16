#!/bin/sh
set -eu

umask 077
export HOME=/data
mkdir -p /data/.cache /data/models /data/model-manager
chmod 0700 /data/models /data/model-manager

exec /app/model-manager \
	--options /data/options.json \
	--state /data/model-manager/state.json \
	--models /data/models \
	--catalog /app/catalog.json \
	--llama /app/llama-server.bin
