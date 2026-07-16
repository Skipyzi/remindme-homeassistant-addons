#!/bin/sh
set -eu

OPTIONS=/data/options.json
get_option() {
	value="$(sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$OPTIONS" | head -n 1)"
	if [ -n "$value" ]; then
		printf '%s' "$value"
	else
		sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p" "$OPTIONS" | head -n 1 | tr -d ' '
	fi
}

HF_REPO="$(get_option hf_repo)"
HF_FILE="$(get_option hf_file)"
HF_TOKEN="$(get_option hf_token)"
MODEL_PATH="$(get_option model_path)"

# Home Assistant may preserve empty YAML strings as the literal text "".
[ "$HF_REPO" = '""' ] && HF_REPO=""
[ "$HF_FILE" = '""' ] && HF_FILE=""
[ "$HF_TOKEN" = '""' ] && HF_TOKEN=""
[ "$MODEL_PATH" = '""' ] && MODEL_PATH=""
CONTEXT_SIZE="$(get_option context_size)"
THREADS="$(get_option threads)"
THREADS_BATCH="$(get_option threads_batch)"
BATCH_SIZE="$(get_option batch_size)"
UBATCH_SIZE="$(get_option ubatch_size)"
CACHE_REUSE="$(get_option cache_reuse)"
JINJA="$(get_option jinja)"
KV_UNIFIED="$(get_option kv_unified)"
FLASH_ATTENTION="$(get_option flash_attention)"
REASONING_FORMAT="$(get_option reasoning_format)"
REASONING_MODE="$(get_option reasoning_mode)"

# llama.cpp stores Hugging Face downloads beneath HOME. Keep them persistent.
export HOME=/data
mkdir -p /data/.cache /data/models

set -- --host 0.0.0.0 --port 8080 \
	--ctx-size "$CONTEXT_SIZE" \
	--threads "$THREADS" \
	--threads-batch "$THREADS_BATCH" \
	--batch-size "$BATCH_SIZE" \
	--ubatch-size "$UBATCH_SIZE" \
	--cache-prompt \
	--cache-reuse "$CACHE_REUSE" \
	--parallel 1

if [ "$JINJA" = "true" ]; then set -- "$@" --jinja; fi
if [ "$KV_UNIFIED" = "true" ]; then set -- "$@" --kv-unified; fi
if [ "$FLASH_ATTENTION" = "true" ]; then set -- "$@" --flash-attn on; fi
if [ -n "$REASONING_FORMAT" ]; then set -- "$@" --reasoning-format "$REASONING_FORMAT"; fi
if [ -n "$REASONING_MODE" ]; then set -- "$@" --reasoning "$REASONING_MODE"; fi

if [ -n "$HF_REPO" ]; then
	set -- "$@" --hf-repo "$HF_REPO"
	if [ -n "$HF_FILE" ]; then set -- "$@" --hf-file "$HF_FILE"; fi
	if [ -n "$HF_TOKEN" ]; then set -- "$@" --hf-token "$HF_TOKEN"; fi
	echo "Starting llama.cpp with Hugging Face model: $HF_REPO"
else
	if [ -z "$MODEL_PATH" ] || [ ! -f "$MODEL_PATH" ]; then
		echo "No model configured. Set hf_repo or provide a valid model_path." >&2
		exit 1
	fi
	set -- "$@" --model "$MODEL_PATH"
	echo "Starting llama.cpp with local model: $MODEL_PATH"
fi

exec /app/llama-server "$@"
