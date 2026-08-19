# Local LLM and Home Assistant Add-ons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local llama.cpp/Qwen3 backend and package the Discord bot and local LLM as separate Home Assistant OS add-ons.

**Architecture:** The Discord bot remains a Node.js service and calls an OpenAI-compatible llama.cpp endpoint for lightweight requests. Complex requests continue through the pi-agent bridge. Home Assistant add-on files package the bot and llama.cpp separately for ARM64, with persistent `/data` storage.

**Tech Stack:** TypeScript, Node.js, discord.js v14, Express, llama.cpp server, Qwen3 1.7B Q4_K_M GGUF, Home Assistant add-on Docker images.

## Global Constraints

- Target Home Assistant OS architecture: `aarch64`.
- Initial local model: Qwen3 1.7B Q4_K_M GGUF.
- Reminder dates and durations remain validated by TypeScript, never trusted directly from model output.
- Reminder storage must survive restarts under `/data/reminders.json` in add-on mode.
- Local LLM API must not be publicly exposed by default.

---

### Task 1: Local LLM client and configuration

**Files:**

- Modify: `src/config.ts`
- Create: `src/localLlm.ts`
- Modify: `src/chat.ts`
- Modify: `.env.example`
- Modify: `package.json`

**Interfaces:**

- Produce `askLocalLlm(prompt: string): Promise<string>`.
- Configuration keys: `LOCAL_LLM_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_TIMEOUT_MS`, `LOCAL_LLM_ENABLED`.

- [ ] Add configuration defaults: disabled by default, URL `http://local-llama-cpp:8080/v1/chat/completions`, model `qwen3-1.7b`, timeout `30000`.
- [ ] Implement an OpenAI-compatible POST client with timeout, HTTP error handling, and `{ choices: [{ message: { content } }] }` response validation.
- [ ] Add routing so `!chat` uses local LLM when enabled, while `!:` continues to use the pi bridge.
- [ ] Split responses at Discord’s 2,000-character limit.
- [ ] Run `pnpm build` and verify it passes.

### Task 2: Persistent reminder storage

**Files:**

- Modify: `src/utils/reminderManager.ts`
- Modify: `src/commands/remind.ts`
- Create: `src/utils/reminderStore.ts`

**Interfaces:**

- `loadReminders(filePath: string): Promise<void>`.
- `saveReminders(filePath: string): Promise<void>`.

- [ ] Store reminder records as JSON-compatible objects, including ID, user ID, channel ID, message, due time, and notified state.
- [ ] Load `/data/reminders.json` when the bot starts and save after create, edit, delete, and notification.
- [ ] Preserve ownership checks and reminder-channel restrictions.
- [ ] Re-arm timers for future loaded reminders.
- [ ] Run `pnpm build` and verify it passes.

### Task 3: Local LLM add-on

**Files:**

- Create: `homeassistant-addons/local-llama-cpp/config.yaml`
- Create: `homeassistant-addons/local-llama-cpp/Dockerfile`
- Create: `homeassistant-addons/local-llama-cpp/run.sh`
- Create: `homeassistant-addons/local-llama-cpp/README.md`

- [ ] Define an `aarch64` add-on with port `8080`, persistent `/data`, configurable model path, context size, and thread count.
- [ ] Build an ARM64 llama.cpp server image.
- [ ] Start llama-server with an OpenAI-compatible `/v1/chat/completions` endpoint.
- [ ] Add a health check and document placing the Qwen3 GGUF model in `/data/models`.
- [ ] Validate the YAML and Dockerfile syntax locally.

### Task 4: Discord bot add-on

**Files:**

- Create: `homeassistant-addons/discord-pi-bot/config.yaml`
- Create: `homeassistant-addons/discord-pi-bot/Dockerfile`
- Create: `homeassistant-addons/discord-pi-bot/run.sh`
- Create: `homeassistant-addons/discord-pi-bot/README.md`
- Create: `homeassistant-addons/repository.yaml`
- Modify: `package.json`

- [ ] Define an `aarch64` add-on with Discord token as a password option and persistent `/data` mapping.
- [ ] Build and run the compiled bot from the add-on container.
- [ ] Pass `LOCAL_LLM_URL`, pi bridge URL, and reminder data path through environment variables.
- [ ] Document installing the custom repository and starting both add-ons.
- [ ] Verify the bot image builds with Docker when Docker is available.

### Task 5: Health, presence, and documentation

**Files:**

- Modify: `src/presence.ts`
- Modify: `README.md`
- Modify: `PI_BRIDGE_SETUP.md`
- Create: `LOCAL_LLM_SETUP.md`

- [ ] Show local LLM and pi-agent availability separately in bot logs and presence.
- [ ] Document routing behavior and fallback behavior.
- [ ] Document Qwen model installation, recommended context size, and Raspberry Pi cooling requirements.
- [ ] Document all environment variables and Home Assistant add-on options.
- [ ] Run `pnpm build` and perform a health endpoint check.
