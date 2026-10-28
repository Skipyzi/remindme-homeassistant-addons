# RemindMe

A personal assistant that lives in Home Assistant and talks to you on Discord. It can see and control your home, read your calendars, to-do lists and the weather, set reminders, keep notes, and message you first: a morning brief, the bins the evening before collection, and batteries running out.

Version 4.0 is one app. It no longer needs the Local llama.cpp app (a Pi is too slow for a useful model) and works without SearXNG. The AI runs in the cloud, on the provider you choose.

## Choosing the AI

Add at least one key in the app's **Configuration** page, then restart the app:

| Provider | Option | Notes |
|---|---|---|
| Claude | `anthropic_api_key` | From console.anthropic.com, billed per use (separate from a Claude subscription). Uses Claude Opus 5.5 unless you pick another model. Searches the web itself. |
| OpenAI | `openai_api_key` | From platform.openai.com. Pick a model in the console. Searches the web itself. |
| OpenCode | `opencode_api_key` | Your OpenCode Go key (`opencode_url` defaults to `https://opencode.ai/zen/go/v1`; use `https://opencode.ai/zen/v1` for Zen). Pick a model in the console. Web search needs `searxng_url` or `exa_api_key`. |
| Custom server | `custom_ai_url`, `custom_ai_key` | Any server that speaks OpenAI's Chat Completions, such as OpenRouter. |

### Or sign in with a subscription

Under **AI → Sign-ins** in the console:

- **ChatGPT subscription:** sign in, approve plan usage, and paste the final page's address back in (it points at the Pi, so your browser usually can't open it). ChatGPT then answers like the API providers, with all the same tools.
- **Claude subscription:** sign in and paste the code Claude shows. Claude runs as an agent through Claude Code.
- **Codex, OpenCode and Pi:** their own sign-ins, in a terminal console. They run as agents too. Codex uses the ChatGPT sign-in when there is one.

The agents (Claude, Codex, OpenCode app, Pi) run each turn themselves with RemindMe's tools and nothing else: no terminal, files or coding tools. Each chat keeps its own agent session. They can't look at pictures, and their usage counts against your subscription, not the daily budget.

`ai_provider` picks the default. In the console, **AI** (the badge at the top, or the drawer) switches between the providers that have a key, picks the model and sets the effort, without a restart. Keys only ever come from the app options; the console never sees them.

`ai_effort` sets how hard the AI thinks on Discord and in scheduled tasks; in the console, the **Thinking** menu under the message box sets it per message. `daily_ai_budget` (US dollars, default 2) pauses the assistant for the rest of the day once reached. Spend is counted from Claude's list prices; OpenAI and OpenCode usage is shown in tokens only, because their APIs publish no prices.

## On Discord

Set `discord_token` and `owner_id`. Then:

- **DM the bot** to talk to the assistant. It remembers the chat for six hours of quiet; say `new` to start over. Mentioning the bot in a server works too. It answers only the owner.
- **Pictures** you send are looked at with Claude or OpenAI.
- **Locks, doors, covers, alarms, scripts and scenes** never run on their own: the reply comes with **Confirm** and **Cancel** buttons.
- **Slash commands** (`/remind`, `/reminders`, `/ping`, `/help`, `/info`) work as before.

The bot must share a server with you, and your DMs must be open to it.

## Messages it sends first

All to your DMs, and part of that chat, so you can reply to them:

- **Morning brief** at `morning_brief_time` (default 07:00): today's shift and appointments, bins tonight, the weather, reminders, parcels, and anything wrong in the house. The facts are gathered in code and the AI writes them up; without the AI you get a plain list. The console's **AI** panel can send today's brief on demand.
- **Bins:** on the morning before a collection, "Put the paper bin out" goes on your chores list (`chores_list`, default `todo.chores`), due that day. At `bin_reminder_time` (default 19:00) you get a message too, unless you've ticked the chore off. German bin names get an English label: paper (Blaue Tonne), packaging (Gelbe Tonne), organic, residual waste.
- **Batteries** at or below `battery_nudge_percent` (default 15), once a week per device.

Nothing is sent during `quiet_hours` (default 22:30-07:00); nudges wait until they end. Blank times turn a message off. The bins and battery checks don't use the AI.

## Connectors: your mail

Add mail accounts in the console under **Settings → Connectors**: Gmail, GMX, WEB.DE, iCloud Mail, or any other IMAP server. Each one is tested before it's saved, shows its last check, and can be switched off or removed. Passwords stay in the app's private data on the Pi and are never shown again. RemindMe reads over IMAP and never sends, deletes, moves or marks mail as read.

- **Gmail** needs 2-step verification and an app password (Google Account → Security → App passwords).
- **GMX** and **WEB.DE** need "POP3/IMAP Abruf" turned on in their mail settings.
- **iCloud Mail** needs an app-specific password from account.apple.com.
- **Outlook.com** isn't offered: Microsoft no longer accepts passwords over IMAP.

Gmail and GMX set in the 4.2 app options are taken in as connectors once. Connectors are built so other kinds (calendars, feeds) can be added the same way.

- **Ask about it:** "did the landlord reply?", "when is my dentist appointment?". Gmail searches all mail, archived included; GMX searches the inbox.
- **The morning brief** gets a line or two on new mail worth knowing. Your inbox sorter app keeps newsletters and social mail out; without it, mailing-list headers do.
- **Nudges** (`mail_nudges`, on by default) for new bills and appointment confirmations, and again the day before a bill is due. Reading those out of new mail takes one short AI request per batch, on the AI chosen under **AI** (not a CLI agent).

Mail text reaches the AI only when a question or the brief needs it, and is treated as information, never as instructions.

## What the assistant can do

House overview, find and control devices, calendar events, weather forecasts, to-do lists (read, add, complete), reminders (set, list, cancel), notes in the shared vault (search, save when asked), web search (built into Claude and OpenAI; SearXNG or Exa for the others), reading a web page, parcel tracking (with `trackingmore_api_key`), documents in the console, and tools from MCP servers added in the console.

It only sees and changes devices through these tools. Each turn sends your recent chat, the tool results and any recalled notes to the provider you chose.

## The console

Open **RemindMe** in the sidebar. It is one ledger, newest first, with now in the middle:

- **The command line** on top: tell RemindMe what to do, or ask. It keeps the thread like a Discord DM; **New topic** starts over. Pictures work with Claude, OpenAI and ChatGPT.
- **Waiting on you:** actions that need your tap (locks, doors, scenes), and batteries running out.
- **The ledger:** what's coming up (reminders, the brief, tonight's bins, your next shift, scheduled tasks), then everything RemindMe answered, changed, sent and failed at, here and on Discord. Changed lamps show in their own colour. Filter it by **Coming up**, **What it did** or **Messages**.
- **Settings:** the AI and sign-ins, how it talks, skills, connected tools (MCP), scheduled tasks and documents.

The assistant always knows which AI and model are answering, and says so when asked.

## Data

Everything lives in `/data`: reminders, chats, the AI choice (`ai.json`), today's spend (`spend.json`), Discord chat history (`discord-chats.json`) and which nudges were sent (`proactive.json`). Notes stay in `/share/vault`, shared with the Vault editor app.

## Upgrading from 3.x

The `local_llm_*`, `model_manager_*` and `pi_agent_webhook_url` options are gone, and so is the console's Models workbench.

From 3.1: your ChatGPT, Claude, Codex, OpenCode and Pi sign-ins carry over, and API keys saved in the old endpoint list keep working until you add them to the app options (options win). Choosing an assistant per conversation is gone: the choice under **AI** applies everywhere, Discord included. The Local llama.cpp and SearXNG apps keep running until you uninstall them; RemindMe no longer uses llama.cpp, and uses SearXNG only for web search with OpenCode or a custom server.

## Development

```sh
pnpm install
pnpm test        # node:test, no network: the AI APIs are faked
pnpm test:agents # the real Codex CLI and a stand-in Claude Code, against simulated ChatGPT
pnpm build && HA_API_URL=http://localhost:8123/api SUPERVISOR_TOKEN=<token> ANTHROPIC_API_KEY=<key> node dist/main.js
```

`HA_API_URL` points at a Home Assistant outside the Supervisor for local runs.
