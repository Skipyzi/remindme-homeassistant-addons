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

# Which AI answers. The console can switch between the providers that have a
# key without a restart; keys themselves only ever come from here.
export AI_PROVIDER="$(get_option ai_provider)"
export AI_MODEL="$(get_option ai_model)"
export AI_EFFORT="$(get_option ai_effort)"
export ANTHROPIC_API_KEY="$(get_option anthropic_api_key)"
export OPENAI_API_KEY="$(get_option openai_api_key)"
export OPENCODE_API_KEY="$(get_option opencode_api_key)"
export OPENCODE_URL="$(get_option opencode_url)"
export CUSTOM_AI_URL="$(get_option custom_ai_url)"
export CUSTOM_AI_KEY="$(get_option custom_ai_key)"
export DAILY_AI_BUDGET="$(get_option daily_ai_budget)"

# The assistant speaking first, on Discord.
export MORNING_BRIEF_TIME="$(get_option morning_brief_time)"
export BIN_REMINDER_TIME="$(get_option bin_reminder_time)"
export QUIET_HOURS="$(get_option quiet_hours)"
export BATTERY_NUDGE_PERCENT="$(get_option battery_nudge_percent)"
export CHORES_LIST="$(get_option chores_list)"

# Mail, read-only over IMAP. The inbox sorter app labels it; blank skips that.
export GMAIL_ADDRESS="$(get_option gmail_address)"
export GMAIL_APP_PASSWORD="$(get_option gmail_app_password)"
export GMX_ADDRESS="$(get_option gmx_address)"
export GMX_PASSWORD="$(get_option gmx_password)"
export MAIL_NUDGES="$(get_option mail_nudges)"
export INBOX_SORTER_URL="$(get_option inbox_sorter_url)"

export SEARXNG_URL="$(get_option searxng_url)"
export EXA_API_KEY="$(get_option exa_api_key)"
export HA_NOTIFY_TARGET="$(get_option ha_notify_target)"
# The companion remindme-vault editor add-on's URL, for deep-linking notes from
# the chat console. Blank hides the link.
export VAULT_UI_URL="$(get_option vault_url)"
# TrackingMore API key for parcel tracking. Blank disables tracking.
export TRACKINGMORE_API_KEY="$(get_option trackingmore_api_key)"
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
export AI_DATA_PATH=/data/ai.json
export SPEND_DATA_PATH=/data/spend.json
export DISCORD_CHAT_PATH=/data/discord-chats.json
export PROACTIVE_DATA_PATH=/data/proactive.json
export ACTIVITY_DATA_PATH=/data/activity.json
export CONSOLE_CHAT_PATH=/data/console-chat.json
export MAIL_DATA_PATH=/data/mail.json
export CONNECTORS_DATA_PATH=/data/connectors.json
# Subscription sign-ins and the CLI agents' own accounts and sessions. Same
# places as 3.1, so existing sign-ins carry over.
export CHATGPT_AUTH_PATH=/data/chatgpt-auth.json
export CLAUDE_CONFIG_DIR=/data/claude-auth
export AGENT_DATA_DIR=/data/agents
# API keys RemindMe 3.x saved in its endpoint list, used while the options are blank.
export LEGACY_ENDPOINTS_PATH=/data/endpoints.json
# The vault is a shared folder, not add-on data, so it lives under /share where
# the remindme-vault editor add-on reads and writes the same files.
export VAULT_DATA_PATH=/share/vault

# One process: the console, the Discord bot and the scheduler share one assistant.
exec node /app/dist/main.js
