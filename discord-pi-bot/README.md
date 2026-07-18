# RemindMe Discord Bot and Home Terminal

Install this add-on after `local-llama-cpp`. Version 2.3.4 replaces Supervisor-mirrored settings and automatic model activation with a reliable manual model workbench. It retains direct one-time pairing, Discord chat, reminders, Assist tools, Exa search, the Pi bridge, persistent presence data, and local model diagnostics.

## Local endpoints

Use the Home Assistant host endpoint for local inference:

```text
http://homeassistant:8080/v1/chat/completions
```

The model manager is server-side only:

```text
http://homeassistant:8080/manager/v1
```

Version 2.3.1 automatically migrates legacy `localhost` and `127.0.0.1` loopback values to these canonical cross-add-on endpoints. Loopback points into the RemindMe container and cannot reach the separate llama.cpp add-on.

Do not expose the manager URL or credentials publicly. On each llama.cpp start, its log prints a short-lived six-character pairing code. Open **Models → Local model vault** and enter that code. The code is single-use, expires, and is rate-limited. RemindMe exchanges it directly with the manager, stores the returned token at `/data/model-manager-token` with owner-only permissions, and never places the code or token in browser persistence.

## Harness-only Settings

The RemindMe **Settings** panel controls only local harness presentation: performance profile, glow intensity, and CRT scanlines. These preferences remain in browser storage. The harness does not read, mirror, write, validate, or restart add-on options through Supervisor.

Change Discord, endpoint, integration, and secret options only in Home Assistant's native add-on **Configuration** page. Existing valid `/data/model-manager-token` files remain reusable after upgrade. Preserve both add-ons' `/data` directories when reinstalling or rolling back.

## Manual Model Workbench

Open **Models** in RemindMe to:

- Compare curated MiniCPM5 1B, Qwen3 1.7B/4B, Granite 3.3 2B, SmolLM3 3B, Gemma 3 4B, and Phi-4 Mini profiles.
- See detected RAM, estimated model/KV memory, context, capabilities, and Pi suitability.
- Download and checksum-verify a model while the running model remains unchanged.
- Cancel resumable downloads.
- Copy or download complete llama.cpp options YAML after verification.
- Remove files that are neither running nor involved in an active operation.

A download does not change the running model. To switch reliably:

1. Download the model and wait for **Verified**.
2. Choose **Copy complete YAML** or **Download YAML**.
3. Open the llama.cpp add-on's native **Configuration** YAML editor.
4. Replace the options, save, and restart the llama.cpp add-on.
5. Return to Models and confirm the **Running** badge.

The copied document uses the exact verified `/data/models/<file>.gguf` path and complete runtime values. Its option-level token fields are intentionally empty; protected manager credentials are never copied. RemindMe discovers the actual runtime model for status and response attribution instead of trusting a mirrored model name.

Curated entries have fixed Hugging Face repositories, filenames, byte lengths, and checksums. Custom repositories are marked **unverified**, receive conservative runtime settings, and still require Hugging Face-only URLs and exact `.gguf` filenames.

## Hugging Face access

Public models do not require an account. For gated models:

1. Accept the model licence on Hugging Face.
2. Create a read-only Hugging Face access token.
3. Enter it under **Hugging Face access and custom GGUF**.

The token is sent once to the server and stored only in the llama.cpp add-on's protected data. The browser field clears after submission. API responses expose only configured/not-configured state.

## Pi 5 8 GB guidance

- **MiniCPM5 1B Q4:** fastest compact assistant candidate.
- **Qwen3 1.7B Q8:** current balanced and tested default.
- **Qwen3 4B Q4:** higher quality but slower; remains compatible until real Pi acceptance is recorded.
- **Gemma 3 4B:** text-only in this release. Vision execution and projector management are a separate future subsystem.

This release does not add speech-to-text, text-to-speech, image inference, or cloud/OpenAI composition.

## Discord presence uptime

RemindMe continues tracking cumulative uptime and lifetime availability across restarts and stopped downtime.

Version 2.3.3 uses Discord's bot-supported Gateway presence fields. Full Social SDK Rich Presence artwork, party data, buttons, and Join actions are not available to bot accounts.

The activity is split into:

```text
name:  RemindMe • Pi connected
state: Up 12d 4h • 99.99% • 3 reminders
```

The name changes to `RemindMe • Pi offline` when the Pi-agent bridge is unavailable. The state counts active, unnotified reminders for `OWNER_ID`; no reminder content or identity enters the presence.

Tracking begins when 2.3.2 first starts. Every stopped gap counts as downtime, including updates, intentional restarts, crashes, and host outages. The heartbeat state is stored at `/data/presence-uptime.json` with owner-only permissions and contains no credentials. To reset the lifetime measurement, stop the add-on and delete only `/data/presence-uptime.json`, then start the add-on again.

## Discord behavior

The bot uses the local model for `!chat` when enabled and the Pi-agent bridge for `!:` requests. Configure the Discord token, owner ID, optional Pi bridge URL, notification target, and Exa key in add-on options.
