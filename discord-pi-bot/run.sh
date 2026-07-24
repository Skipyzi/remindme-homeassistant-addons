#!/bin/sh
set -eu

OPTIONS=/data/options.json
get_option() {
	node -e "const o=JSON.parse(require('fs').readFileSync('$OPTIONS','utf8')); process.stdout.write(String(o['$1'] ?? ''))"
}

export DISCORD_BOT_TOKEN="$(get_option discord_token)"
export OWNER_ID="$(get_option owner_id)"
# Register slash commands to this one guild for instant availability; blank
# registers globally (up to ~1h to propagate).
export DISCORD_GUILD_ID="$(get_option guild_id)"
# Surreal random placeholder text for slash commands; "false" for plain text.
export PLAYFUL_PLACEHOLDERS="$(get_option playful_placeholders)"
# Accent colour of the reminder card, as a hex string (e.g. 5865f2).
export REMINDER_COLOR="$(get_option reminder_color)"
export PI_AGENT_WEBHOOK_URL="$(get_option pi_agent_webhook_url)"
export LOCAL_LLM_ENABLED="$(get_option local_llm_enabled)"
LOCAL_LLM_URL="$(get_option local_llm_url)"
case "$LOCAL_LLM_URL" in
"" | "http://127.0.0.1:8080/v1/chat/completions" | "http://localhost:8080/v1/chat/completions" | "http://local-llama-cpp:8080/v1/chat/completions")
	LOCAL_LLM_URL="http://homeassistant:8080/v1/chat/completions" ;;
esac
export LOCAL_LLM_URL
export LOCAL_LLM_MODEL="$(get_option local_llm_model)"
export LOCAL_LLM_CONTEXT_SIZE="$(get_option local_llm_context_size)"
export LOCAL_LLM_VISION="$(get_option local_llm_vision)"
export MODEL_MANAGER_ENABLED="$(get_option model_manager_enabled)"
MODEL_MANAGER_URL="$(get_option model_manager_url)"
case "$MODEL_MANAGER_URL" in
"" | "http://127.0.0.1:8080/manager/v1" | "http://localhost:8080/manager/v1" | "http://local-llama-cpp:8080/manager/v1")
	MODEL_MANAGER_URL="http://homeassistant:8080/manager/v1" ;;
esac
export MODEL_MANAGER_URL
export MODEL_MANAGER_TOKEN_PATH=/data/model-manager-token
export SEARXNG_URL="$(get_option searxng_url)"
export EXA_API_KEY="$(get_option exa_api_key)"
export HA_NOTIFY_TARGET="$(get_option ha_notify_target)"
# The companion remindme-vault editor add-on's URL, for deep-linking notes from
# the chat console. Blank hides the link.
export VAULT_UI_URL="$(get_option vault_url)"
# AfterShip API key for parcel tracking. Blank disables tracking.
export AFTERSHIP_API_KEY="$(get_option aftership_api_key)"
# Only /data is a persisted volume. Anything defaulting to ./data lands in
# /app inside the image and is lost on every restart and update.
export REMINDER_DATA_PATH=/data/reminders.json
export CONVERSATION_DATA_PATH=/data/conversations.json
export SKILL_DATA_PATH=/data/skills.json
export MCP_DATA_PATH=/data/mcp.json
export ARTIFACT_DATA_PATH=/data/artifacts.json
export PRESENCE_UPTIME_PATH=/data/presence-uptime.json
export TASK_DATA_PATH=/data/tasks.json
export PERSONA_DATA_PATH=/data/persona.json
export PARCEL_DATA_PATH=/data/parcels.json
# The vault is a shared folder, not add-on data, so it lives under /share where
# the remindme-vault editor add-on reads and writes the same files.
export VAULT_DATA_PATH=/share/vault

node /app/dist/harness-server.js &
exec node /app/dist/index.js
