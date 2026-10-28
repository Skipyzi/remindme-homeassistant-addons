# RemindMe

A personal assistant that lives in Home Assistant and talks to you on Discord. It can see and control your home, read your calendars, to-do lists and the weather, set reminders, keep notes, and message you first: a morning brief, the bins the evening before collection, and batteries running out.

Version 4.0 is one app. It no longer needs the Local llama.cpp app (a Pi is too slow for a useful model) and works without SearXNG. The AI runs in the cloud, on the provider you choose.

## Choosing the AI

Add at least one key in the app's **Configuration** page, then restart the app:

| Provider | Option | Notes |
|---|---|---|
| Claude | `anthropic_api_key` | From console.anthropic.com, billed per use (separate from a Claude subscription). Uses Claude Opus 5.5 unless you pick another model. Searches the web itself. |
| OpenAI | `openai_api_key` | From platform.openai.com. Pick a model in the console. Searches the web itself. |

### Or sign in with a subscription

Under **AI → Sign-ins** in the console:

- **ChatGPT subscription:** sign in, approve plan usage, and paste the final page's address back in (it points at the Pi, so your browser usually can't open it). ChatGPT then answers like the API providers, with all the same tools.
- **Claude subscription:** sign in and paste the code Claude shows. Claude runs as an agent through Claude Code.
- **Codex:** its own sign-in, in a terminal console. It runs as an agent too, and uses the ChatGPT sign-in when there is one.

The agents (Claude and Codex) run each turn themselves with RemindMe's tools and nothing else: no terminal, files or coding tools. Each chat keeps its own agent session. They can't look at pictures, and their usage counts against your subscription, not the daily budget.

`ai_provider` picks the default. In the console, **Settings → AI and sign-ins** switches between the providers that are set up and picks the model without a restart. Models come in a table: what each is good for, a rough guide to smarts and speed, what a typical answer costs (or how much of a subscription it uses), and how many answers the daily budget covers. Older versions, and typing a model's exact name, are under **Older and other models**. Keys only ever come from the app options; the console never sees them.

`ai_effort` sets how hard the AI thinks; **How hard it thinks** under Settings → AI in the console changes it without a restart. `daily_ai_budget` (US dollars, default 2) pauses the assistant for the rest of the day once reached. Spend is counted from Claude's list prices; OpenAI usage is shown in tokens only, because its API publishes no prices.

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

Add mail accounts in the console under **Settings → Connectors**: Gmail, GMX, WEB.DE, iCloud Mail, or any other IMAP server. Each one is tested before it's saved, shows its last check, and can be switched off or removed. Passwords stay in the app's private data on the Pi and are never shown again. RemindMe reads over IMAP and never sends, deletes, moves or marks mail as read. The one thing it writes is a draft, when you ask for one.

- **Gmail** needs 2-step verification and an app password (Google Account → Security → App passwords).
- **GMX** and **WEB.DE** need "POP3/IMAP Abruf" turned on in their mail settings.
- **iCloud Mail** needs an app-specific password from account.apple.com.
- **Outlook.com** isn't offered: Microsoft no longer accepts passwords over IMAP.

Gmail and GMX set in the 4.2 app options are taken in as connectors once. Connectors are built so other kinds (calendars, feeds) can be added the same way.

- **Ask about it:** "did the landlord reply?", "when is my dentist appointment?". Gmail searches all mail, archived included; GMX searches the inbox.
- **Drafts:** "write the landlord that Tuesday works" saves a reply in that account's Drafts folder, threaded under their mail. You check it and send it yourself from Gmail or GMX; RemindMe never sends.
- **The morning brief** gets a line or two on new mail worth knowing. Your inbox sorter app keeps newsletters and social mail out; without it, mailing-list headers do.
- **Nudges** (`mail_nudges`, on by default) for new bills and appointment confirmations, and again the day before a bill is due. Reading those out of new mail takes one short AI request per batch, on the AI chosen under **AI** (not a CLI agent).

Mail text reaches the AI only when a question or the brief needs it, and is treated as information, never as instructions.

## Calendars

RemindMe reads every calendar in Home Assistant and adds events to the one chosen under **Settings → Connectors → New events go to**. "Put the dentist on Friday at 10" comes back as a button; nothing is added until you tap it. With no calendar chosen, it asks which one.

To use iCloud, add Home Assistant's **CalDAV** integration (Settings → Devices & services → Add integration): server `https://caldav.icloud.com`, your Apple ID, and an app-specific password from account.apple.com. Your iCloud calendars then show in Home Assistant, and events RemindMe adds show on your iPhone and Mac.

## What the assistant can do

House overview, find and control devices, calendar events (read, and add once you confirm), mail (search, read, save drafts), weather forecasts, to-do lists (read, add, complete), reminders (set, list, cancel), notes in the shared vault (search, save when asked), web search (built into Claude, OpenAI and ChatGPT; SearXNG or Exa for the Claude Code and Codex agents), reading a web page, parcel tracking (with `trackingmore_api_key`), documents in the console, and tools from MCP servers added in the console.

It only sees and changes devices through these tools. Each turn sends your recent chat, the tool results and any recalled notes to the provider you chose.

## The console

Open **RemindMe** in the sidebar. It is an inbox. On a phone a thread opens over the inbox; on a wide screen they sit side by side.

- **Needs you:** actions waiting for your tap (locks, doors, scenes, calendar events), questions from jobs with their answers as buttons, and batteries running out.
- **Working on:** background jobs with how far along they are, and your scheduled tasks.
- **Today, Yesterday, Earlier:** every conversation and job, and what RemindMe sent or did elsewhere (the brief, nudges, reminders, Discord).
- **Cats:** every conversation and job has its own cat (a ginger tabby, tuxedo, calico, siamese, grey or black cat, with a bow tie, beret, glasses, headphones, party hat or scarf). It shows how things stand: busy while a job works, a paw raised when it needs you, content when done, grey and dizzy when it stopped.
- **The box at the bottom:** ask, or hand something off. Every request opens a thread of its own; reply in it to carry on. Pictures work with Claude, OpenAI and ChatGPT.
- **History:** the full timeline: what's coming up, then everything RemindMe answered, changed, sent and failed at, with changed lamps in their own colour.
- **Settings:** the AI and sign-ins, connectors and calendars, how it talks, skills, connected tools (MCP), scheduled tasks and documents.

## The phone app

RemindMe installs on your phone as an app with its own notifications. It joins your tailnet as a device of its own (the `phone_app` option, on by default), so it gets a private HTTPS address that only your Tailscale account can open. No port is opened on your network.

1. In the console, open **Settings → Phone app** and press **Connect to Tailscale**. Sign in with the account your phone uses; RemindMe appears in your Tailscale admin console as `remindme`.
2. If it says HTTPS isn't on for your tailnet, follow its link and turn on MagicDNS and HTTPS certificates.
3. On the phone, with Tailscale on, open the address it shows (`https://remindme.<your-tailnet>.ts.net`). iPhone: Share → Add to Home Screen, then open it from the home screen. Android: Chrome menu → Install app.
4. In the installed app, open **Settings → Phone app → Turn on notifications here**, then **Send a test**.

Notifications come for job questions and results, reminders, the morning brief and nudges, alongside Discord; tapping one opens what it is about. On an iPhone they show a title and text only: iOS gives web apps no buttons or pictures in notifications. The app icon counts what waits for your decision, and the app opens on a black RemindMe splash on iPhone and Android. Requests from other accounts and from tagged devices on the tailnet are turned away. Tailscale's state stays in `/data/tailscale`, and its logs aren't uploaded.

## Background jobs

Work that takes many steps, such as comparing flights across sites, going through a week of receipts, or researching a purchase, goes to a job instead of a single answer. You ask as usual, here or on Discord; the AI decides to hand it off. The job:

- runs in the background, one at a time, on the AI chosen under **AI**, and survives a restart;
- writes down each step in its thread, with progress when it knows it;
- asks you when only you can decide, with options to tap in the inbox or to answer on Discord;
- finishes with a result, sent to you on Discord as well;
- stops after six runs of up to ten tool steps each to check in, so it can't run up the bill. Reply "carry on" to continue, or **Stop** it any time.

Device changes, calendar events and the like still wait for your tap, as everywhere else.

The assistant always knows which AI and model are answering, and says so when asked.

## Data

Everything lives in `/data`: reminders, chats, the inbox's threads and jobs (`threads.json`), the phone app's notification keys and devices (`push.json`) and Tailscale's state (`tailscale/`), the AI choice (`ai.json`), today's spend (`spend.json`), Discord chat history (`discord-chats.json`) and which nudges were sent (`proactive.json`). Notes stay in `/share/vault`, shared with the Vault editor app.

## Upgrading from 3.x

The `local_llm_*`, `model_manager_*` and `pi_agent_webhook_url` options are gone, and so is the console's Models workbench.

From 3.1: your ChatGPT, Claude and Codex sign-ins carry over, and API keys saved in the old endpoint list keep working until you add them to the app options (options win). Choosing an assistant per conversation is gone: the choice under **AI** applies everywhere, Discord included. The Local llama.cpp and SearXNG apps keep running until you uninstall them; RemindMe no longer uses llama.cpp, and uses SearXNG only for web search with the Claude Code and Codex agents.

## Development

```sh
pnpm install
pnpm test        # node:test, no network: the AI APIs are faked
pnpm test:agents # the real Codex CLI and a stand-in Claude Code, against simulated ChatGPT
pnpm build && HA_API_URL=http://localhost:8123/api SUPERVISOR_TOKEN=<token> ANTHROPIC_API_KEY=<key> node dist/main.js
```

`HA_API_URL` points at a Home Assistant outside the Supervisor for local runs.
