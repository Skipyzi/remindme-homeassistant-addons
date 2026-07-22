#!/bin/sh
set -eu

# The vault is shared markdown under /share so Obsidian desktop and the
# RemindMe add-on read and write the very same files.
export VAULT_DATA_PATH=/share/vault
export VAULT_PORT=8091

mkdir -p /share/vault

exec node /app/dist/server.js
