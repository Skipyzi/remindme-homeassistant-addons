#!/usr/bin/with-contenv bashio
set -euo pipefail

MODEL_PATH="$(bashio::config 'model_path')"
CONTEXT_SIZE="$(bashio::config 'context_size')"
THREADS="$(bashio::config 'threads')"

if [ ! -f "$MODEL_PATH" ]; then
	bashio::log.error "Model not found: $MODEL_PATH"
	bashio::log.info "Copy a Qwen3 1.7B Q4_K_M GGUF model into /data/models."
	exit 1
fi

exec /app/llama-server \
	--host 0.0.0.0 \
	--port 8080 \
	--model "$MODEL_PATH" \
	--ctx-size "$CONTEXT_SIZE" \
	--threads "$THREADS" \
	--parallel 1
