# Local LLM and Home Assistant Add-ons Design

## Goal

Run the Discord bot on Home Assistant OS and add a separate ARM64 llama.cpp add-on for local, lightweight LLM responses on an 8 GB Raspberry Pi 5.

## Architecture

```text
Home Assistant OS
├── Discord Pi Bot add-on
│   ├── Discord commands and reminders
│   ├── Discord embeds/buttons
│   ├── Local LLM client
│   └── Pi-agent bridge for complex requests
└── llama.cpp Local LLM add-on
    ├── llama-server
    ├── Qwen3 1.7B Q4_K_M GGUF model
    └── Internal OpenAI-compatible HTTP API
```

The bot will connect to the local model through an internal URL such as:

```text
http://local-llama-cpp:8080/v1/chat/completions
```

The exact hostname will be configurable because Home Assistant add-on network names can vary by installation.

## Request Routing

1. Reminder requests are handled by the deterministic TypeScript parser first.
2. Simple chat requests can use the local llama.cpp endpoint.
3. Requests requiring tools, browsing, coding, or complex reasoning use the pi-agent bridge.
4. If the local LLM is unavailable, the bot reports that state and can fall back to the pi bridge when appropriate.

The LLM will not directly schedule reminders. It may extract intent, but dates and durations are validated by TypeScript before a reminder is created.

## Discord Bot Changes

- Add a configurable OpenAI-compatible local LLM client.
- Add `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL`, and timeout settings.
- Show local-model availability in rich presence.
- Preserve the existing pi-agent bridge.
- Persist reminder data under `/data/reminders.json` in add-on mode.
- Keep reminders restricted to channels containing `reminders`.
- Preserve reminder embeds, localized Discord timestamps, IDs, and delete controls.

## llama.cpp Add-on

The custom add-on will:

- Target `aarch64`.
- Run `llama-server` in server mode.
- Load a Q4 quantized Qwen3 1.7B GGUF model.
- Store model files in `/data/models`.
- Expose port 8080 to the internal Home Assistant network.
- Allow configurable model path, context size, and thread count.
- Avoid exposing the model API publicly unless explicitly configured.

## Home Assistant Add-on Packaging

The repository will include:

```text
homeassistant-addons/
├── repository.yaml
├── discord-pi-bot/
│   ├── config.yaml
│   ├── Dockerfile
│   ├── run.sh
│   └── README.md
└── local-llama-cpp/
    ├── config.yaml
    ├── Dockerfile
    ├── run.sh
    └── README.md
```

Secrets such as the Discord token will be supplied through add-on options and environment variables, not committed to source control.

## Failure Handling

- Local LLM health checks update the bot presence.
- HTTP timeout prevents Discord requests from hanging indefinitely.
- Invalid or incomplete LLM output is rejected by the deterministic reminder parser.
- Model unavailability produces a clear Discord response.
- Add-on state and reminders survive restarts through `/data`.

## Verification

- TypeScript build passes.
- Local LLM client accepts an OpenAI-compatible response.
- Reminder parsing remains deterministic and tested for minutes, hours, days, weeks, dates, and weekdays.
- Discord reminder cards still render and delete buttons enforce ownership.
- Add-on configuration validates on ARM64-compatible Docker builds.
- llama.cpp health endpoint responds after startup.
