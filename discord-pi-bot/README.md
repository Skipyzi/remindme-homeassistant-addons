# RemindMe

A personal assistant that lives in Home Assistant and talks to you on Discord. It can see and control your home, read your calendars, to-do lists and the weather, set reminders, keep notes, and message you first: a morning brief, the bins the evening before collection, and batteries running out.

Version 4.0 is one app. It no longer needs the Local llama.cpp app (a Pi is too slow for a useful model) and works without SearXNG. The AI runs in the cloud, on the provider you choose.

## Choosing the AI

Add at least one key in the app's **Configuration** page, then restart the app:

| Provider | Option | Notes |
|---|---|---|
| Claude | `anthropic_api_key` | From console.anthropic.com, billed per use (separate from a Claude subscription). Uses Claude Opus 5.5 unless you pick another model. Searches the web itself. |
| OpenAI | `openai_api_key` | From platform.openai.com. Pick a model in the console. Searches the web itself. |

### A model per thread

**Settings → AI** picks the default. The chat keeps the AI that first answered it, and shows its model under the assistant's name: tap it for that AI's other models (Haiku to Opus is fine, Claude to ChatGPT isn't). For another AI, start the chat over under **Settings → Your assistant**. A background task keeps the AI it started on, and its page says which. Changing the default only affects what starts after. If an AI is later removed, its chat or task falls back to the default. The daily news has its own **Written by** under **Settings → News**; Haiku writes it well for a fraction of Opus's price.

Every earlier message reaches the AI with the time it was sent, and every earlier answer with what its tools did then (reminders set, documents written, actions waiting for a tap). So "in 90 minutes" from last night stays last night's 90 minutes, and a reminder it set an hour ago isn't second-guessed.

### Or sign in with a subscription

Under **AI → Sign-ins** in the console:

- **ChatGPT subscription:** sign in, approve plan usage, and paste the final page's address back in (it points at the Pi, so your browser usually can't open it). ChatGPT then answers like the API providers, with all the same tools.
- **Claude subscription:** sign in and paste the code Claude shows. Claude runs as an agent through Claude Code.
- **Codex:** its own sign-in, in a terminal console. It runs as an agent too, and uses the ChatGPT sign-in when there is one.

The agents (Claude and Codex) run each turn themselves with RemindMe's tools and nothing else: no terminal, files or coding tools. Each chat keeps its own agent session. They can't look at pictures, and their usage counts against your subscription, not the daily budget.

`ai_provider` picks the default. In the console, **Settings → AI and sign-ins** switches between the providers that are set up and picks the model without a restart. Models come in a table: what each is good for, a rough guide to smarts and speed, what a typical answer costs (or how much of a subscription it uses), and how many answers the daily budget covers. Older versions, and typing a model's exact name, are under **Older and other models**. Keys only ever come from the app options; the console never sees them.

`ai_effort` sets how hard the AI thinks; **How hard it thinks** under Settings → AI in the console changes it without a restart. `daily_ai_budget` (US dollars, default 2) pauses the assistant for the rest of the day once reached. Spend is counted from Claude's list prices; OpenAI usage is shown in tokens only, because its API publishes no prices.

## On Discord

Discord is optional. Without it, the brief, reminders and nudges come to the phone app and the RemindMe chat in the console. Set `discord_token` and `owner_id` to add it. Then:

- **DM the bot** to talk to the assistant. It remembers the chat for six hours of quiet; say `new` to start over. Mentioning the bot in a server works too. It answers only the owner.
- **Pictures** you send are looked at with Claude or OpenAI.
- **Locks, doors, covers, alarms, scripts and scenes** never run on their own: the reply comes with **Confirm** and **Cancel** buttons.
- **Slash commands** (`/remind`, `/reminders`, `/ping`, `/help`, `/info`) work as before.

The bot must share a server with you, and your DMs must be open to it.

**Settings → Discord** says who the bot is logged in as, and whether RemindMe's own messages (below) go to your DMs too. Turned off, they come only to your phone and the RemindMe chat; it still answers when you write to it on Discord, and a reminder set in a Discord channel still rings there.

## Messages it sends first

To the phone app, the RemindMe chat in the console, and your Discord DMs unless you turned that off (there they're part of the chat, so you can reply to them):

- **Morning brief** at `morning_brief_time` (default 07:00): today's shift and appointments, bins tonight, the weather, reminders, parcels, and anything wrong in the house. The facts are gathered in code and the AI writes them up; without the AI you get a plain list. The console's **AI** panel can send today's brief on demand.
- **Bins:** on the morning before a collection, "Put the paper bin out" goes on your chores list (`chores_list`, default `todo.chores`), due that day. At `bin_reminder_time` (default 19:00) you get a message too, unless you've ticked the chore off. German bin names get an English label: paper (Blaue Tonne), packaging (Gelbe Tonne), organic, residual waste.
- **Batteries** at or below `battery_nudge_percent` (default 15), once a week per device: what to buy when the device says (a CR2032, two AAA), or "needs charging" for devices with a charging sensor, left out while they charge. Phones with the Companion app are left out: they warn about themselves.
- **Heads-ups** (`smart_nudges`, on by default): every two hours between the brief and quiet hours, RemindMe looks across new mail, the next three hours of your calendar, doors, windows and locks left open, leak or smoke alarms, and jobs that have waited long for you, and messages you only about what can't wait. Nothing is told twice, and there are four a day at most. One short AI request per pass, only when there's something new to look at.

Nothing is sent during `quiet_hours` (default 22:30-07:00); nudges wait until they end. Blank times turn a message off. The bins and battery checks don't use the AI.

## Connectors: your mail

Add mail accounts in the console under **Settings → Connectors**: Gmail, GMX, WEB.DE, iCloud Mail, or any other IMAP server. Each one is tested before it's saved, shows its last check, and can be switched off or removed. Passwords and sign-ins stay in the app's private data on the Pi and are never shown again. RemindMe reads over IMAP and never deletes, moves or marks mail as read. It writes a draft when you ask for one, and sends an email only after you tap Send.

- **Gmail** can sign in with Google, or use an app password (Google Account → Security → App passwords; needs 2-step verification). Signing in also lets RemindMe look up addresses in your Google contacts. It needs your own Google app, made once: the console walks through it and shows the two values Google asks for. Publish the app ("In production"), or Google ends the sign-in after 7 days, and sign in from a device with Tailscale on, since Google sends you back to the phone app's address.
- **GMX** and **WEB.DE** need "POP3/IMAP Abruf" turned on in their mail settings.
- **iCloud Mail** needs an app-specific password from account.apple.com.
- **Outlook.com** isn't offered: Microsoft no longer accepts passwords over IMAP.

Gmail and GMX set in the 4.2 app options are taken in as connectors once.

- **Ask about it:** "did the landlord reply?", "when is my dentist appointment?". Gmail searches all mail, archived included; GMX searches the inbox.
- **Drafts:** "write the landlord that Tuesday works" saves a reply in that account's Drafts folder, threaded under their mail, for you to finish and send yourself.
- **Sending:** "send the landlord that Tuesday works" writes the reply and shows it, with who it goes to, as a card with **Send** and **Cancel**. Nothing goes out until you tap Send. It's sent from the account the mail came to (Gmail, GMX, WEB.DE and iCloud Mail need nothing more; other mail needs its SMTP server) and filed in Sent. RemindMe never sends because an email or a page asks it to.
- **The morning brief** gets a line or two on new mail worth knowing. Your inbox sorter app keeps newsletters and social mail out; without it, mailing-list headers do.
- **Nudges** (`mail_nudges`, on by default) for new bills and appointment confirmations, and again the day before a bill is due. Reading those out of new mail takes one short AI request per batch, on the AI chosen under **AI** (not a CLI agent).

Mail text reaches the AI only when a question or the brief needs it, and is treated as information, never as instructions.

## Connectors: feeds

Any RSS or Atom feed can be a connector too, such as a blog, a newsroom, a YouTube channel or a project's releases on GitHub. Add it under **Settings → Connectors → Feeds** by its link. A site's own address works when the site names its feed (Home Assistant, GitHub releases, YouTube channels and most blogs do). Each feed has two switches:

- **In the daily news**: its posts join the digest under **News**, with the sources ticked there.
- **Tell me about new posts**: it's checked every half hour, never during quiet hours, with no AI. A new post comes to your phone (with **Open**), Discord and the RemindMe thread; several come as one short list. Give it a few words ("Zigbee, Matter") to hear only about posts that mention one of them. The posts already there when you add the feed aren't news.

Ask "anything new on the Home Assistant blog?" and the assistant reads your feeds. A feed added under **News** is a feed connector that's in the news, with new-post notices off.

## Connectors: parcels (DHL)

DHL's own Shipment Tracking API can be a connector, so DHL parcels are tracked straight from DHL, without an aggregator in between. It covers DHL Paket, Express, eCommerce and Post shipments. Add it under **Settings → Connectors → Parcels** with a free key of your own:

1. Sign up at [developer.dhl.com](https://developer.dhl.com/user/register).
2. Under **My Apps**, create an app named RemindMe with the API **Shipment Tracking - Unified**.
3. Show the app's **API Key** (not the secret) and paste it in. RemindMe tries it before saving it.

Your postcode is optional; with it, DHL names the towns along the way. Give RemindMe a tracking number ("track 340434161094, it's the keyboard"), or ask it to track the parcel from a shipping email, and you hear when it moves, is out for delivery, waits at a Packstation or arrives. DHL's free level allows 250 checks a day. RemindMe checks each parcel every 45 minutes outside quiet hours (every 15 once it's out for delivery), keeps 50 checks for when you ask, and stops tracking once it's delivered. Hermes, DPD, GLS and UPS still go through TrackingMore (`trackingmore_api_key`).

## Where you are

RemindMe knows where you are from your person in Home Assistant, which follows your phone through the Home Assistant app (location access set to **Always**). Every message tells the assistant only roughly: at home, in one of your zones, or away and about how far from home, with how old that is. Ask "where am I?", "what's near me?" or "is there a pharmacy around here?" and it uses **user_location**: when the phone's last report is more than ten minutes old, it asks the phone for a fresh one (a silent notification the Home Assistant app answers), then looks up the nearest address on OpenStreetMap. **find_place** can search around you instead of around home.

**Settings → Phone app → Where you are** shows what the assistant is told and when the phone last reported, with **Ask the phone now**. If the phone hasn't reported for an hour, it says which settings on the phone to check.

## Reminders by place

"Remind me when I get home", "when I leave the office", "next time I'm at the pharmacy": RemindMe follows your person in Home Assistant, which knows where your phone is through the Home Assistant app (location access set to **Always**). A place is home, another Home Assistant zone by its name, or a spot it found on the map (within about 200 m). It looks every half minute and acts once a move has held for a minute, so a phone at the edge of a zone doesn't set it off; the reminder then goes out like any other. Said while you're already there, "when I get home" waits for the next time you arrive. Reminders fire once unless you ask for every time; they're listed in History under Coming up, where Cancel removes them.

**Settings → Phone app → Where you are** picks whose whereabouts it follows: by default the person whose tracker is the phone picked for notifications, or the only person. Zones are made in Home Assistant under Settings → Areas, labels & zones; a zone is more reliable than a spot from the map, since the phone reports crossing it right away.

## Calendars

RemindMe reads every calendar in Home Assistant and adds events to the one chosen under **Settings → Connectors → New events go to**. "Put the dentist on Friday at 10" comes back as a button; nothing is added until you tap it. With no calendar chosen, it asks which one.

To use iCloud, add Home Assistant's **CalDAV** integration (Settings → Devices & services → Add integration): server `https://caldav.icloud.com`, your Apple ID, and an app-specific password from account.apple.com. Your iCloud calendars then show in Home Assistant, and events RemindMe adds show on your iPhone and Mac.

## What the assistant can do

House overview, find and control devices, calendar events (read, and add once you confirm), mail (search, read, save drafts), weather forecasts, to-do lists (read, add, complete), reminders (set, list, cancel), notes in the shared vault (search, save when asked), web search (built into Claude, OpenAI and ChatGPT; SearXNG or Exa for the Claude Code and Codex agents), reading a web page, parcel tracking (DHL as a connector, other carriers with `trackingmore_api_key`), documents in the console, and tools from MCP servers added in the console. Servers with their own sign-in, such as Notion, Linear and Todoist, need only their address and a tap on Sign in.

It only sees and changes devices through these tools. Each turn sends your recent chat, the tool results and any recalled notes to the provider you chose.

## The console

Open **RemindMe** in the sidebar, or the phone app. It's laid out like Claude Duet: one chat, and the tasks it runs in the background. Three tabs float at the bottom of a phone and run down the side of a wide screen. It's true black throughout, for OLED screens, with glass for what floats over the page.

- **Chat:** your one conversation with your assistant, under its name, cat and model (RemindMe until you name it). It also holds the morning brief, nudges, reminders, heads-ups and what it changed on its own, by day, with their buttons (a battery's Remind me Saturday, a reminder's In 1 hour), so "done" or "remind me at 9" work in context. Work that takes a while goes off as a task: its card shows in the chat and keeps up while it works, and the task posts back here when it's done or needs you, with its options as buttons. The box at the bottom takes text, pictures (with Claude, OpenAI and ChatGPT) and dictation.
- **Tasks:** what needs you (actions waiting for your tap, a task's question, batteries running out), what's working, what it's watching (a parcel, a price), what's coming up (reminders, by place first, scheduled tasks and what it will send) and what's done. A battery's **Remind me Saturday** hides it until then; **Got it** hides it until it's charged or changed. A task opens on a page of its own with its steps: reply there, **Stop** it or delete it. The tab's badge counts what needs you. Notifications about a task open its page.
- **Made:** the documents it wrote and what it remembers, newest first.
- **History:** the full timeline, from Tasks: what's coming up, then everything RemindMe answered, changed, sent and failed at, with changed lamps in their own colour. Conversations from before there was one chat are at the bottom.
- **Cats:** every conversation and job has its own cat (a ginger tabby, tuxedo, calico, siamese, grey or black cat, with a bow tie, beret, glasses, headphones, party hat or scarf). It shows how things stand: busy while a job works, a paw raised when it needs you, content when done, grey and dizzy when it stopped.
- **Dictation:** the microphone in the text box. Tap it, speak (up to a minute), tap it again: the words land in the box for you to read before sending. With Home Assistant's speech-to-text running (the Whisper app with its Wyoming integration), it's written down on the Pi and your voice stays at home; pick its language under **Settings → Phone app → Dictation**. Without it, the browser's own speech recognition is used where there is one (Safari, Chrome), which sends your voice to Apple or Google. The microphone needs the https address, so it works in the phone app, not over plain http.
- **Settings:** the gear by the chat's name. Grouped into AI (who answers and the model, your assistant, memory, skills), accounts and devices (mail and calendars, the phone app, connected tools) and what it does on its own (scheduled tasks, documents). Each section shows what it's set to, and anything broken is listed on top. On a phone, Settings is a list you tap into; on a computer, the list stays on the left.

### Your assistant

**Settings → Your assistant** gives it a name (up to 24 characters) and a cat: one of six coats and something to wear, or nothing. The name heads its chat and goes into its instructions, so it answers to it. **How it talks** below holds its standing instructions. Its chat keeps the AI it started with; **Start the chat over** moves what was said to History and lets the next answer come from the AI chosen under **AI and sign-ins**. Memory, reminders and jobs aren't touched.

### What it may do

**Settings → What it may do** sets, for each kind of action, whether RemindMe does it on its own, asks you first (it waits for your tap in the chat, under Tasks, on your phone and on Discord) or never does it:

| Kind | Choices | As it comes |
|---|---|---|
| Lights, switches, heating and media | Just do it, Ask me, Never | Just do it |
| Blinds, shades and valves | Just do it, Ask me, Never | Ask me |
| Scenes, scripts, vacuums and the rest | Just do it, Ask me, Never | Ask me |
| Locks, doors, gates and the alarm | Ask me, Never | Ask me |
| Calendar events | Just do it, Ask me, Never | Ask me |
| To-do lists | Just do it, Ask me, Never | Just do it |
| Sending email | Ask me, Never | Ask me |
| Buying, booking and signing up on websites | Ask me, Never | Ask me |
| Background jobs | Just do it, Ask me, Never | Just do it |

What opens the house or speaks for you is never done unasked. Background jobs follow the same rules, and RemindMe is told what you changed, so it says so instead of looking for another way. Your own taps in the console aren't affected.

## The phone app

RemindMe installs on your phone as an app with its own notifications. It joins your tailnet as a device of its own (the `phone_app` option, on by default), so it gets a private HTTPS address that only your Tailscale account can open. No port is opened on your network.

1. In the console, open **Settings → Phone app** and press **Connect to Tailscale**. Sign in with the account your phone uses; RemindMe appears in your Tailscale admin console as `remindme`.
2. If it says HTTPS isn't on for your tailnet, follow its link and turn on MagicDNS and HTTPS certificates.
3. On the phone, with Tailscale on, open the address it shows (`https://remindme.<your-tailnet>.ts.net`). iPhone: Share → Add to Home Screen, then open it from the home screen. Android: Chrome menu → Install app.
4. In the installed app, open **Settings → Phone app → Turn on notifications here**, then **Send a test**.

Notifications come for job questions and results, reminders, the morning brief and nudges, alongside Discord; tapping one opens what it is about. On an iPhone they show a title and text only: iOS gives web apps no buttons or pictures in notifications. The app icon counts what waits for your decision, and the app opens on a black RemindMe splash on iPhone and Android. Requests from other accounts and from tagged devices on the tailnet are turned away. Tailscale's state stays in `/data/tailscale`, and its logs aren't uploaded.

### Through the Home Assistant app

On an iPhone, a web app's notifications are text only. The Home Assistant app on the phone can do more, without a developer account, so RemindMe can send through it instead (**Settings → Phone app → Through the Home Assistant app**, or the `ha_notify_target` option):

- **Buttons:** a job's question with its answers and a reply field; an action a job left waiting, with Confirm (only from an unlocked phone) and Cancel; a battery's **Remind me Saturday** and **Got it**; a reminder's **In 1 hour**. The answer takes the notification's place.
- **The thread's cat** as the picture, drawn by the web browser and loaded over the phone app's address, so Tailscale has to be on.
- **Live Activities:** a job working for more than a few seconds shows on the Lock Screen with its latest step and progress, and leaves when it stops.

While it's on, the web app's own notifications stay quiet, so nothing arrives twice. Taps come back as Home Assistant's `mobile_app_notification_action` event; each button works once.

## Background tasks

Work that takes many steps, such as comparing flights across sites, going through a week of receipts, or researching a purchase, goes to a task instead of a single answer. You ask as usual, in the chat or on Discord; the AI decides to hand it off. The task:

- runs in the background, one at a time, on the AI chosen under **AI**, and survives a restart;
- writes down each step in its thread, with progress when it knows it;
- asks you when only you can decide, with options to tap in the chat or under Tasks, or to answer on Discord;
- finishes with a result in the chat, on your phone, and on Discord unless you turned that off;
- stops after six runs of up to ten tool steps each to check in, so it can't run up the bill. Reply "carry on" to continue, or **Stop** it any time;
- for keep-me-updated requests (a parcel, a reply), watches instead: it looks once, then sleeps until the time it set or until an email arrives whose sender or subject has its words (the carrier, an order number). It tells you only what changed, never looks during quiet hours, and stops after a week. A sleeping watch costs nothing; **Stop watching** ends it.

Device changes, calendar events and the like still wait for your tap, as everywhere else.

The assistant always knows which AI and model are answering, and says so when asked.

## Web browser

For pages a plain read can't handle, such as DHL tracking, shops and timetables, RemindMe has a headless Chromium on the Pi (`web_browser`, on by default). The AI opens pages, clicks, types into searches and reads what comes back.

- It browses signed out, starts with a fresh profile every time, and never types into password, card or bank fields.
- A click that would buy, book, send or sign up, or a form that asks for your details, waits for your tap like any other held action.
- It can't reach your home network, Home Assistant or the Supervisor, and Chromium runs as its own user without RemindMe's keys or access to `/data`.
- It starts when needed and closes after three minutes without use, using about 200–400 MB of memory while open.

## Cards in answers

Answers can come with cards under the text, built from what RemindMe's tools found rather than written by the AI:

- **Offers**: the product's picture, the cheapest few shops with shipping, and whether you watch its price (from **compare_prices** and price watches).
- **Places**: a small OpenStreetMap map, whether it's open right now (read from its opening hours), the address, the distance from home, and **Directions**, **Website** and **Call**. Ask "is there a pharmacy open near the Hauptbahnhof?" or "when does the Rewe in Gohlis close?". OpenStreetMap's hours can be out of date.
- **Articles**: posts from your feeds, news headlines and pages RemindMe read, with their pictures; several sit on a shelf you swipe.
- **The news digest** in RemindMe's thread shows its stories with photos and every source.

Each tool gives its findings an id, and the AI shows the ones that matter, so every price, picture and link on a card comes from a tool. Pictures and map tiles load through RemindMe on the Pi (only addresses it handed out itself, kept for a few weeks in `/data/media`), so your phone never contacts the shops or news sites. Discord, notifications and scheduled tasks get the cards as plain lines.

## Prices

Ask "where is the Sony WH-1000XM5 cheapest?" and RemindMe reads the offers on [Geizhals](https://geizhals.de), which compares German and Austrian shops: the cheapest few with shop, delivery and shipping, and similar products. (idealo turns automated browsers away, so it isn't used.)

Ask it to watch a price ("tell me when the XM5 is under 180 €"), or add one under **Settings → Price watches** with a product's name or a link:

- A name is looked up on Geizhals, preferring a product that's on sale now; RemindMe says which one it found, so you can correct it. Geizhals' product pages carry every offer's price, so these checks need no AI at all.
- A link to any shop's product page also works: the browser reads the page and the cheapest model (Claude Haiku or GPT Luna) picks out the price. A link whose price can't be read isn't kept.
- It checks every six hours, never during quiet hours, and keeps a short price history with the lowest price seen.
- You hear about it on your phone and in the chat when the price falls under your target or, without a target, drops by 5 % or more since it last told you. The notice has **Open** and **Stop watching**; the same price again isn't news.

Searching Geizhals needs the web browser (`web_browser`).

## News

Every day at a time you choose, RemindMe sends a short digest of the news from Germany, the EU and the world. Set it up under **Settings → News**:

- Tick your sources. From Germany: tagesschau, Deutschlandfunk, ZDFheute, DER SPIEGEL, ZEIT ONLINE, Süddeutsche Zeitung, taz, n-tv, Handelsblatt and DW. European: Euronews, POLITICO Europe and Euractiv. International: BBC News, the Guardian, France 24, Al Jazeera, NPR and the New York Times. Any other RSS or Atom feed can be added by its link; it becomes a feed connector (below) that's in the news.
- The news agencies themselves (dpa, Reuters, AP, AFP) publish no feeds. dpa's wire comes in as headlines through ZEIT ONLINE's newsticker.
- RemindMe reads the last day's headlines and teasers. The AI picks the 3 or 5 most important stories per section, merges a story that several sources tell, and writes a line or two on each, in English or German, with a link to every source. Links always come from the feeds, never from the AI. That's one AI answer a day, roughly 5–10 cents on Claude Opus and much less on smaller models.
- The digest goes to Discord, your phone (one headline per section) and the RemindMe thread, never during quiet hours. Without the AI (no key, or over the day's budget) it sends the headlines themselves.
- Ask "what's in the news about the Bundestag?" at any time: the assistant reads the same sources.

## Memory

RemindMe remembers things about you: what it picked up from what you told it ("my sister Anna lives in Berlin"), and what you add yourself. Every answer gets them, so you don't have to say them twice. It learns only from your own messages, never from emails or web pages, and never keeps passwords, codes or long numbers. **Settings → Memory** lists everything it remembers: forget any of it, add to it, or switch learning off.

## Data

Everything lives in `/data`: reminders, chats, the chat and the tasks (`threads.json`), what it remembers about you (`memory.json`), which heads-ups were sent (`triage.json`), batteries you dealt with (`batteries.json`), price watches (`prices.json`), the news settings (`news.json`), which feed posts were seen (`feeds.json`; the feeds themselves are connectors), pictures and map tiles for cards (`media/`), the phone app's notification keys and devices (`push.json`) and Tailscale's state (`tailscale/`), the AI choice (`ai.json`), today's spend (`spend.json`), Discord chat history (`discord-chats.json`) and which nudges were sent (`proactive.json`). Notes stay in `/share/vault`, shared with the Vault editor app.

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
