# RemindMe Discord Bot

Install this add-on after the `local-llama-cpp` add-on. Configure the Discord token, owner ID, pi bridge URL, and local LLM URL in the Home Assistant add-on options.

The local model endpoint should normally be:

```text
http://local-llama-cpp:8080/v1/chat/completions
```

The bot uses the local model for `!chat` when enabled and the pi-agent bridge for `!:` requests.
