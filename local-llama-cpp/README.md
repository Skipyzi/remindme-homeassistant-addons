# Local llama.cpp

ARM64 llama.cpp server for the RemindMe Discord bot.

Place a Qwen3 1.7B Q4_K_M GGUF model at:

```text
/config/local_llama_cpp/models/qwen3-1.7b-q4_k_m.gguf
```

Configure the add-on model path if the filename differs. The API listens on port 8080 and exposes `/v1/chat/completions`.
