#!/usr/bin/env bash
# Run the controller against a throwaway data directory with direct API access
# enabled, so a browser and curl can drive it without Home Assistant Ingress.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"

data_dir="${MC_DEV_DATA:-${TMPDIR:-/tmp}/mc-addon-dev}"
listen="${MC_LISTEN:-127.0.0.1:8099}"
options="$data_dir/options.json"

mkdir -p "$data_dir"
if [[ ! -f "$options" ]]; then
  cat > "$options" <<'JSON'
{
  "server_port": 25565,
  "memory_min_mb": 1024,
  "memory_max_mb": 2048,
  "jvm_flags_profile": "balanced",
  "stop_timeout_seconds": 60,
  "mqtt_enabled": false,
  "mqtt_port": 1883,
  "mqtt_discovery_prefix": "homeassistant",
  "chunky_source": "modrinth",
  "allow_direct_access": true,
  "log_level": "debug"
}
JSON
  echo "wrote development options to $options"
fi

echo "data directory: $data_dir"
echo "management UI:  http://$listen/"
echo
echo "Note: without a Home Assistant Supervisor there is no MQTT and no Ingress."
echo "      allow_direct_access is enabled in the development options above so the"
echo "      UI can change state; never enable it on a real installation unless you"
echo "      understand what it opens up."
echo

cd "$root/backend"
MC_DATA_DIR="$data_dir" \
MC_OPTIONS_FILE="$options" \
MC_FRONTEND_DIR="$root/frontend" \
MC_ASSETS_DIR="$root" \
MC_LISTEN="$listen" \
MC_LOG_LEVEL="${MC_LOG_LEVEL:-debug}" \
  exec go run ./cmd/controller
