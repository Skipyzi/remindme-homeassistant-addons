#!/bin/sh
set -eu

OPTIONS=/data/options.json
get_option() {
	node -e "const o=JSON.parse(require('fs').readFileSync('$OPTIONS','utf8')); process.stdout.write(String(o['$1'] ?? ''))"
}

export DISCORD_BOT_TOKEN="$(get_option discord_token)"
export OWNER_ID="$(get_option owner_id)"
export PI_AGENT_WEBHOOK_URL="$(get_option pi_agent_webhook_url)"
export LOCAL_LLM_ENABLED="$(get_option local_llm_enabled)"
LOCAL_LLM_URL="$(get_option local_llm_url)"
case "$LOCAL_LLM_URL" in
"" | *127.0.0.1* | *localhost* | *local-llama-cpp*) LOCAL_LLM_URL="http://homeassistant:8080/v1/chat/completions" ;;
esac
export LOCAL_LLM_URL
export LOCAL_LLM_MODEL="$(get_option local_llm_model)"
export EXA_API_KEY="$(get_option exa_api_key)"
export REMINDER_DATA_PATH=/data/reminders.json

node /app/dist/harness-server.js &
exec node /app/dist/index.js
