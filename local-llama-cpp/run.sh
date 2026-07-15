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
CONTEXT_SIZE="$(get_option context_size)"
THREADS="$(get_option threads)"

# llama.cpp stores Hugging Face downloads beneath HOME. Keep them persistent.
export HOME=/data
mkdir -p /data/.cache /data/models

set -- --host 0.0.0.0 --port 8080 --ctx-size "$CONTEXT_SIZE" --threads "$THREADS" --parallel 1

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
