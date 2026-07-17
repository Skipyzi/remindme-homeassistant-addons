# RemindMe Discord Bot and Home Terminal

Install this add-on after `local-llama-cpp`. Version 2.3.2 adds persistent lifetime uptime and availability to the Discord rich presence. It retains synchronized settings, direct one-time pairing, Discord chat, reminders, Assist tools, Exa search, the Pi bridge, and the Hardware Cookbook.

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

Do not expose the manager URL or credentials publicly. On each llama.cpp start, its log prints a short-lived six-character pairing code. Enter that code in **Settings → Hardware cookbook → Local model vault**. The code is single-use, expires, and is rate-limited. RemindMe exchanges it directly with the manager, stores the returned token at `/data/model-manager-token` with owner-only permissions, and never places the code or token in browser persistence. RemindMe does not require Supervisor `manager` or `admin` privileges.

## Synchronized settings

Supervisor-rendered add-on options are the canonical configuration. The sidebar reloads live values, mirrors every safe schema field, and exposes only configured/not-configured flags for Discord and Exa secrets. To replace a secret, enter a new value; leaving the replacement blank preserves the configured value. RemindMe writes its complete self-options map directly and relies on Supervisor's atomic validation; it does not call the privileged `/addons/self/options/validate` route.

Saving uses a revision check. If the native Configuration tab changed after the sidebar was opened, RemindMe reports a **configuration changed** conflict instead of overwriting newer values. Reload settings, review the live values, and save again.

Settings marked as startup-bound are saved without disrupting the current response. Use the explicit **Restart add-on** control when ready; the sidebar waits for a new process instance before reconnecting through ingress.

After upgrading from 2.2.x, existing options remain intact. Existing valid `/data/model-manager-token` files are reused. Otherwise, pair once using the current code from the llama.cpp add-on log. If an older build cannot save from the sidebar, use Home Assistant's native **Configuration** tab to enter the canonical URLs, save, and restart RemindMe. Roll back by reinstalling the previous add-on versions; do not delete either add-on's `/data` directory if you want to preserve models and credentials.

## Hardware Cookbook

Open **Settings → Hardware cookbook** in RemindMe to:

- Compare curated MiniCPM5 1B, Qwen3 1.7B/4B, Granite 3.3 2B, SmolLM3 3B, Gemma 3 4B, and Phi-4 Mini profiles.
- See detected RAM, estimated model/KV memory, context, stability, capabilities, and Pi suitability.
- Download while the active model keeps serving chat.
- Activate an installed model with health/completion probes.
- Cancel resumable downloads.
- Restore the previous model automatically after a failed activation.
- Keep the active and most recent fallback models protected.

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

Version 2.3.2 displays cumulative bot uptime and lifetime availability alongside Pi-agent connectivity, for example `Pi connected • Up 12d 4h • 99.99% • !help`.

Tracking begins when 2.3.2 first starts. Every stopped gap counts as downtime, including updates, intentional restarts, crashes, and host outages. The heartbeat state is stored at `/data/presence-uptime.json` with owner-only permissions and contains no credentials. To reset the lifetime measurement, stop the add-on and delete only `/data/presence-uptime.json`, then start the add-on again.

## Discord behavior

The bot uses the local model for `!chat` when enabled and the Pi-agent bridge for `!:` requests. Configure the Discord token, owner ID, optional Pi bridge URL, notification target, and Exa key in add-on options.
