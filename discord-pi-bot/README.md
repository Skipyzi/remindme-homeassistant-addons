# RemindMe Discord Bot and Home Terminal

Install this add-on after `local-llama-cpp`. Version 2.3.4 replaces Supervisor-mirrored settings and automatic model activation with a reliable manual model workbench. It retains direct one-time pairing, Discord chat, reminders, Assist tools, Exa search, the Pi bridge, persistent presence data, and local model diagnostics.

## Agent core (3.0)

Version 3.0 replaces the tool-calling loop with an agent core built for small local models. The model no longer receives a tool list and never emits a tool call. Each chat turn goes through up to four steps, and any of them can finish it:

1. **Home Assistant first.** Plain device commands and questions ("turn off the kitchen light", "what's the temperature in the office") go to Home Assistant's built-in intent engine (`conversation.home_assistant`). If it handles them, no model runs at all. Requests mentioning locks, doors, the garage, covers, alarms, scenes, scripts or the vacuum never take this path, because Home Assistant would act on them without confirmation.
2. **One constrained decision.** The model picks a single action (`reply`, `home_control`, `home_status`, `reminder_add`, `web_search`, `memory_recall`, `document_write`, …) by filling in a JSON schema that llama.cpp compiles into a grammar. It cannot produce invalid JSON, invent an action, or name a device that isn't on the shortlist. The shortlist is ranked in code from device names, areas and the previous request.
3. **The action runs in code.** Home commands become checked service calls, such as percent → 0–255 brightness, colour names → RGB and "warmer" → kelvin. Lights, switches, fans, media and climate run straight away. Locks, covers, valves, alarms, scripts, scenes, vacuums and anything unfamiliar wait for a confirm tap.
4. **A spoken answer, only when needed.** Device actions and status reads answer from a template. Search results, notes and chat go to the model as plain text generation, with no tools on offer. Documents are streamed as plain source (no JSON escaping) and saved.

Guard rails a model can't bypass:

- `home_control` is only in the grammar when the message contains a command word ("turn", "set", "dim", "open", "lock", …) or is a short follow-up to one. "Why do LED lights flicker?" can read a device state but never switch anything.
- Memory is saved only when you ask ("remember that…", "keep in mind…", "make a note"). Relevant notes are still recalled automatically into every answer.
- If a decision fails (the endpoint rejects the schema, or the model is unreachable mid-turn), the turn falls back to a plain answer instead of a broken tool call.

### Measuring a model

`eval/run.mts` runs the routing decision against a live endpoint over a fixture house and 47 labelled prompts. It covers commands, state questions, knowledge questions that mention devices, follow-ups, reminders, search, memory, documents and parcels:

```sh
LOCAL_LLM_URL=http://homeassistant:8080/v1/chat/completions pnpm eval
```

Results at release (same prompts; decision latency measured on a desktop CPU, so a Pi will be slower):

| Model | Exact | Right action | v1 tool-calling, same prompts |
|---|---|---|---|
| SpeakoFlow-Mini 0.8B Q4 | 87% | 91% | 23% |
| Qwen3 1.7B Q8 | 91% | 98% | — |
| Qwen3 4B Q4 | 96% | 100% | — |

SpeakoFlow-Mini is a dictation-cleanup model: it routes well under the grammar, but it rewrites your message instead of answering it. If the llama.cpp add-on is also serving a cleanup model to a dictation app, keep it as the add-on's default, and pick a separate **chat model** in **Models**. Local llama.cpp 2.0 serves every downloaded model from one endpoint. The console names its chat model on every request, while apps that name no model keep getting the default. **Use this model** and **Download & use** choose the chat model only; **Make default** changes what other apps get.

## Console UI (3.0)

The web console was rebuilt mobile-first in a warmer version of the amber Lucky 38 style:

- **Voice, not capitals:** Fraunces, a soft serif, for the greeting, headings and readings; IBM Plex Sans for reading text; Plex Mono only for code. All three are bundled locally, so nothing is fetched at runtime.
- **A face:** a small tower-and-disc emblem marks the console and sits beside its replies. A cursor blinks while a reply is being written.
- **The house at a glance:** a new chat opens with a time-of-day greeting, a one-line pulse (lights on, indoor temperature, open doors or windows, the next reminder, from `/api/pulse`), and a few one-tap suggestions.
- **Phone:** one column, with a drawer for chats and the Models, Skills, MCP and Settings panels. Panels open as bottom sheets and documents open full screen. Text fields use 16px type, so iOS no longer zooms in when you tap one.
- **Desktop (1024px and up):** a fixed sidebar, a centred chat column, and documents in a resizable pane beside it.
- **Themes:** pick one under Settings: Lucky 38 (amber lamplight, the default), Vault (green phosphor), Nocturne (moonlit blue) or Daylight (warm paper and ink, a light theme). The choice is saved in the browser and applied before the page first paints.
- **Calmer by default:** warm lamplight and a fine grain instead of flicker. Scanlines are off until you enable them in Settings, and the background ASCII animation runs only on desktop, at about 12 frames per second.

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
