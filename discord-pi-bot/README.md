# RemindMe Discord Bot and Home Terminal

Install this add-on after `local-llama-cpp`. Version 2.2.1 adds the Hardware Cookbook model vault to the RemindMe Home Assistant sidebar while retaining Discord chat, reminders, Assist tools, Exa search, and the Pi bridge. Sidebar settings now preserve the complete add-on configuration when saved.

## Local endpoints

Use the Home Assistant host endpoint for local inference:

```text
http://homeassistant:8080/v1/chat/completions
```

The model manager is server-side only:

```text
http://homeassistant:8080/manager/v1
```

Do not expose the manager URL or credentials publicly. RemindMe generates a random pairing token, stores it under its protected `/data`, and updates the llama.cpp add-on through the Supervisor API. The token never enters browser state.

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

## Discord behavior

The bot uses the local model for `!chat` when enabled and the Pi-agent bridge for `!:` requests. Configure the Discord token, owner ID, optional Pi bridge URL, notification target, and Exa key in add-on options.
