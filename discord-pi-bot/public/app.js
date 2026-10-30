/*
 * The RemindMe console, laid out like Duet: one chat with the assistant,
 * the tasks it runs in the background (what needs you, what's running,
 * what's coming up, what's done), and what it made. Work that takes a while
 * goes off as a task with a page of its own and reports back in the chat.
 * The old timeline is History.
 */

const KIND_LABELS = {
	answered: "answered",
	did: "did",
	confirmed: "did",
	sent: "sent",
	failed: "failed",
	cancelled: "cancelled",
	waiting: "waiting",
};

/* RemindMe's own thread: what it sent and did on its own, and the replies to it. */
const FEED = "remindme";
/* The recording or recogniser running now; kept out of Alpine's state, which would wrap and call into it. */
let dictating = null;
const storedNumber = (key) => {
	try {
		return Number(localStorage.getItem(key)) || 0;
	} catch {
		return 0;
	}
};

const CHANNEL_NOTES = {
	discord: "On Discord",
	brief: "Morning brief",
	news: "Daily news",
	nudge: "Heads-up",
	reminder: "Reminder",
	task: "Scheduled task",
	job: "From a task",
};

const TOOL_WORDS = {
	house_overview: "checking the house",
	find_devices: "finding devices",
	control_devices: "changing devices",
	calendar_events: "reading the calendars",
	add_calendar_event: "preparing the event",
	weather_forecast: "checking the weather",
	todo_items: "reading the lists",
	todo_add: "adding to a list",
	todo_complete: "ticking off an item",
	set_reminder: "setting a reminder",
	list_reminders: "reading reminders",
	cancel_reminder: "cancelling a reminder",
	search_notes: "searching notes",
	save_note: "saving a note",
	web_search: "searching the web",
	read_web_page: "reading a page",
	track_parcel: "tracking a parcel",
	list_parcels: "checking parcels",
	write_document: "writing a document",
	edit_document: "editing a document",
	search_mail: "searching your mail",
	read_mail: "reading a mail",
	draft_mail: "writing a draft",
	start_job: "handing it to a job",
	reply_to_job: "passing it to the job",
};

const JOB_WORDS = { queued: "Waiting its turn", working: "Working", waiting: "Watching", needs_you: "Needs you", done: "Done", stopped: "Stopped" };
/* The tabs; the chat is home. */
const TABS = ["chat", "tasks", "made"];
/* The first word of a held action, when it is a plain verb, names its button. */
const VERBS = new Set(["Unlock", "Lock", "Open", "Close", "Add", "Run", "Arm", "Disarm", "Send"]);

function pad(value) {
	return String(value).padStart(2, "0");
}

const euroFormat = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
function euro(value) {
	return value === undefined || value === null ? "–" : euroFormat.format(value);
}
/* "179,90", "179.90 €", "180" → 179.9; anything else, nothing. */
function euroNumber(text) {
	const value = Number(String(text || "").replace(/[€\s]/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function dayKey(date) {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function firstLine(text) {
	return (
		String(text || "")
			.replace(/\*\*|__|`/g, "")
			.split("\n")
			.map((line) => line.replace(/^[#>\-•*\s]+/, "").trim())
			.find(Boolean) || ""
	);
}

function remindme() {
	return {
		/* Which tab shows: the chat, the tasks, or what it made */
		tab: "chat",
		/* Where a task's page was opened from, for its back button */
		openedFrom: "tasks",
		/* What the inbox call brings: the AI's state, what waits, the threads and jobs */
		splash: true,
		ai: null,
		waiting: [],
		batteries: [],
		threads: [],
		scheduled: [],
		activity: [],
		now: new Date(),
		loaded: false,
		error: "",
		draft: "",
		pictures: [],
		/* The open thread, and a turn streaming into it */
		open: null,
		replyDraft: "",
		streaming: null,
		sending: false,
		busy: false,
		abort: null,
		/* History: the old ledger */
		historyOpen: false,
		upcoming: [],
		entries: [],
		filter: "all",
		tabs: [
			{ id: "all", label: "Everything" },
			{ id: "coming", label: "Coming up" },
			{ id: "did", label: "What it did" },
			{ id: "messages", label: "Messages" },
		],
		/* Settings */
		settingsOpen: false,
		settingsTab: "ai",
		/* Settings: grouped, each with a line on what it's set to; on a phone a list you tap into. */
		sections: [
			{ id: "ai", label: "AI and sign-ins", group: "AI" },
			{ id: "prompt", label: "Your assistant", group: "AI" },
			{ id: "rules", label: "What it may do", group: "AI" },
			{ id: "memory", label: "Memory", group: "AI" },
			{ id: "skills", label: "Skills", group: "AI" },
			{ id: "connectors", label: "Connectors", group: "Accounts and devices" },
			{ id: "phone", label: "Phone app", group: "Accounts and devices" },
			{ id: "discord", label: "Discord", group: "Accounts and devices" },
			{ id: "mcp", label: "Connected tools", group: "Accounts and devices" },
			{ id: "news", label: "News", group: "On its own" },
			{ id: "prices", label: "Price watches", group: "On its own" },
			{ id: "tasks", label: "Scheduled tasks", group: "On its own" },
			{ id: "documents", label: "Documents", group: "On its own" },
		],
		phoneLayout: window.matchMedia("(max-width: 820px)").matches,
		/* Models the chat, a task or the news can be given ("provider|model" in the pickers) */
		modelChoices: { default: null, groups: [] },
		/* The assistant: its name and cat */
		assistant: { name: "RemindMe", cat: "remindme" },
		identity: { name: "", look: { coat: 0, accessory: 0 } },
		identityNote: "",
		/* Dictation: Home Assistant's speech-to-text on the Pi, or the browser's own */
		dictation: { entity: null, name: "", languages: [], hint: "" },
		dictationLang: (() => {
			try {
				return localStorage.getItem("rm-dictation-lang") || navigator.language || "en";
			} catch {
				return navigator.language || "en";
			}
		})(),
		listening: null,
		/* Discord: the bot, and whether RemindMe's messages go there too */
		discord: { bot: null, messages: true, phones: 0 },
		discordNote: "",
		/* What it may do on its own, per kind of action */
		rules: [],
		rulesNote: "",
		/* Place reminders: the people in Home Assistant, and whose whereabouts they follow */
		location: { people: [], person: null, chosen: null, reminders: 0 },
		locationNote: "",
		/* The daily news */
		news: { on: false, time: "07:30", language: "en", stories: 5, sources: [], catalog: [], own: [] },
		newsNote: "",
		newsBusy: false,
		newFeed: "",
		feedBusy: false,
		feedResult: null,
		newDhl: { apiKey: "", postcode: "" },
		dhlBusy: false,
		dhlResult: null,
		newFeedLink: "",
		/* Price watches */
		priceWatches: [],
		newPrice: { what: "", target: "" },
		priceNote: "",
		priceBusy: false,
		aiModels: [],
		modelTable: { billing: "unknown", budget: 0, featured: [], others: [] },
		modelsOpen: false,
		customModel: "",
		aiModel: "",
		aiEffort: "low",
		aiBusy: false,
		aiError: "",
		aiTest: null,
		signinStatus: {},
		signin: null,
		persona: "",
		personaStatus: "",
		skills: [],
		newSkillName: "",
		newSkillBody: "",
		skillError: "",
		mcpServers: [],
		newMcpName: "",
		newMcpUrl: "",
		newMcpAuth: "",
		mcpError: "",
		/* Connected tools that only need their address and a sign-in. */
		mcpPicks: [
			{ name: "Notion", url: "https://mcp.notion.com/mcp" },
			{ name: "Linear", url: "https://mcp.linear.app/mcp" },
			{ name: "Todoist", url: "https://ai.todoist.net/mcp" },
		],
		tasks: [],
		newTaskWhat: "",
		newTaskWhen: "",
		taskError: "",
		documents: [],
		connectors: [],
		connectorKinds: [],
		newConnector: { preset: "gmail", how: "google", name: "", address: "", password: "", host: "", port: "993", smtpHost: "", smtpPort: "587" },
		/* The user's own Google app, for signing in with Google. */
		googleApp: { set: false, clientId: "", redirectUri: "", domain: "", host: "", editing: false },
		googleForm: { clientId: "", clientSecret: "" },
		connectorBusy: false,
		connectorResult: null,
		calendars: { list: [], newEvents: null, note: "", error: "" },
		/* Memory: what RemindMe knows about you */
		memory: { learn: true, facts: [] },
		newMemory: "",
		memoryNote: "",
		/* The phone app: Tailscale, and notifications on this device */
		phone: { state: "" },
		phoneBusy: false,
		phoneNote: "",
		haPhone: { phones: [], target: "", liveActivities: true, pictures: false },
		haNote: "",
		phoneCopied: false,
		phoneTimer: null,
		pushOn: false,
		/* The CLI agents' sign-in console (account-console.js) */
		authConsole: { id: "", backend: "", running: false, output: "", urls: [] },
		authConsoleOpen: false,
		authConsoleBackend: "codex",
		authConsoleInput: "",
		authConsoleError: "",
		authConsoleBusy: false,
		/* RemindMe's thread: when it was last opened here, and whether older days are folded. */
		feedSeen: storedNumber("rm-feed-seen"),
		feedFold: true,
		feedTop: "",
		/* Made: what it wrote and what it remembers */
		madeFilter: "all",
		madeLoaded: false,
		notes: [],
		/* What a change did, with a moment to take it back */
		toast: null,
		/* Inside Home Assistant's app panel on a phone: its header is hidden, so ☰ stands in. */
		haNarrow: false,
		haLinked: "",

		init() {
			const fit = () => document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
			fit();
			window.addEventListener("resize", fit);
			window.matchMedia("(max-width: 820px)").addEventListener("change", (event) => {
				this.phoneLayout = event.matches;
				if (!event.matches && !this.settingsTab) this.settingsTab = "ai";
			});
			this.loadInbox();
			this.loadModelChoices();
			this.loadDictation();
			this.route();
			window.addEventListener("popstate", () => this.route());
			// A tapped notification opens its thread by changing the address.
			window.addEventListener("hashchange", () => this.route());
			this.joinHomeAssistant();
			// Installed on a phone (not inside Home Assistant), it works offline and gets notifications.
			if (this.inPhoneApp && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
			setInterval(() => {
				this.now = new Date();
				if (!this.sending && !document.hidden) this.loadInbox();
			}, 15_000);
			// A job that is running reports in; its thread follows along while open.
			setInterval(() => {
				if (this.open && !this.open.readOnly && !this.streaming && !document.hidden && this.isRunning(this.open)) this.refreshThread();
			}, 3_000);
			// While a task runs, its card in the chat and on Tasks keeps up, and its news arrives in the chat.
			setInterval(() => {
				if (!this.sending && !document.hidden && this.running.length && !this.isRunning(this.open)) this.loadInbox();
			}, 6_000);
			// What's coming up moves with the clock.
			setInterval(() => {
				if (this.tab === "tasks" && !document.hidden) this.loadUpcoming();
			}, 60_000);
			document.addEventListener("visibilitychange", () => {
				if (document.hidden) return;
				this.loadInbox();
				if (this.open && !this.open.readOnly && !this.streaming) this.refreshThread();
			});
		},

		/* ── The inbox ───────────────────────────────────────────────── */

		async loadInbox() {
			try {
				const response = await fetch("./api/inbox", { cache: "no-store" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = await response.json();
				this.ai = { ...(this.ai || {}), ...data.ai };
				if (data.assistant) this.assistant = data.assistant;
				this.waiting = data.waiting || [];
				// A battery just dealt with keeps its card a moment longer, to show what happened.
				const settled = this.batteries.filter((item) => item.done);
				this.batteries = [...(data.batteries || []).filter((item) => !settled.some((done) => done.entityId === item.entityId)), ...settled];
				this.threads = data.threads || [];
				this.scheduled = data.tasks || [];
				this.activity = data.activity || [];
				const top = this.activity[0]?.id || "";
				if (this.open?.feed && top !== this.feedTop) this.showFeed(true);
				this.feedTop = top;
				this.now = new Date(data.now || Date.now());
				this.loaded = true;
				this.error = "";
				this.showBadge();
			} catch (error) {
				this.error = `RemindMe isn't answering (${error.message || error}). It may be restarting.`;
			} finally {
				this.splash = false;
			}
		},

		/* The app icon's count: what waits for your decision. */
		showBadge() {
			if (!this.inPhoneApp || !("setAppBadge" in navigator)) return;
			const count = this.waiting.length + this.asking.length;
			(count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
		},

		/* Settings call this after a change; it refreshes whatever is showing. */
		async loadLedger() {
			await this.loadInbox();
			if (this.historyOpen) await this.loadHistory();
		},

		get asking() {
			return this.threads.filter((thread) => thread.job?.status === "needs_you" && thread.job.question);
		},

		/* Jobs: running now (or waiting their turn), watching for a change, and done. */
		get running() {
			return this.threads.filter((thread) => ["queued", "working"].includes(thread.job?.status));
		},
		get watching() {
			const jobs = this.threads
				.filter((thread) => thread.job?.status === "waiting")
				.map((thread) => ({ key: `t-${thread.id}`, thread: thread.id, title: thread.title, line: this.taskNote(thread) || (thread.job.wakeAt ? `Looks again ${this.formatWhen(thread.job.wakeAt)}` : "Watching") }));
			const prices = this.priceWatches.map((watch) => ({ key: `p-${watch.id}`, title: watch.name, line: this.priceLine(watch) }));
			return [...jobs, ...prices];
		},
		get doneTasks() {
			return this.threads
				.filter((thread) => ["done", "stopped"].includes(thread.job?.status) && !thread.archivedAt)
				.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
				.slice(0, 12);
		},
		/* Reminders, by place first, then the next week's reminders, scheduled tasks and what it will send. */
		get comingUp() {
			const items = this.upcoming
				.filter((item) => item.kind === "reminder" || item.kind === "will send")
				.map((item, index) => ({ key: `u-${index}-${item.at}`, at: new Date(item.at), place: Boolean(item.place), text: item.text, note: item.kind === "will send" ? "It sends this" : "" }));
			for (const task of this.scheduled) if (task.nextRun) items.push({ key: `s-${task.id}`, at: new Date(task.nextRun), place: false, text: task.name, note: `Scheduled, ${task.schedule}` });
			return items
				.sort((a, b) => (a.place === b.place ? a.at - b.at : a.place ? -1 : 1))
				.slice(0, 8)
				.map((item) => ({ ...item, time: this.shortWhen(item.at.toISOString(), true) }));
		},

		get needsCount() {
			return this.waiting.length + this.asking.length + this.batteries.length;
		},
		get tasksLine() {
			const needs = this.needsCount;
			const parts = [needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "Nothing needs you", this.running.length ? `${this.running.length} working` : ""];
			return parts.filter(Boolean).join(", ");
		},
		get tasksEmpty() {
			return !this.needsCount && !this.running.length && !this.watching.length && !this.comingUp.length && !this.doneTasks.length;
		},

		/* The chat's tab: how many of the assistant's own messages came since it was last open. */
		get feedRow() {
			return { fresh: this.activity.filter((item) => Date.parse(item.at) > this.feedSeen).length };
		},

		/* Chats from before there was one main chat, and archived ones: in History. */
		get otherChats() {
			return this.threads.filter((thread) => !thread.job && thread.id !== FEED).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
		},

		get appClass() {
			return `on-${this.tab}${this.open && !this.open.feed ? " task-open" : ""}`;
		},
		get backLabel() {
			return this.openedFrom === "chat" ? `‹ ${this.assistant.name}` : this.openedFrom === "history" ? "‹ Back" : "‹ Tasks";
		},
		get micTarget() {
			return this.open?.feed ? "draft" : "reply";
		},

		/* A task as a card: its thread from the inbox, how it's doing, and its latest line. */
		taskOf(id) {
			return this.threads.find((thread) => thread.id === id);
		},
		taskClass(thread) {
			const status = thread?.job?.status;
			return { working: status === "queued" || status === "working", asking: status === "needs_you", watching: status === "waiting", done: status === "done", stopped: status === "stopped", gone: !thread };
		},
		taskState(thread) {
			if (!thread) return "Deleted";
			if (!thread.job) return "Chat";
			const progress = thread.job.progress ? `, ${thread.job.progress.done} of ${thread.job.progress.total}` : "";
			return `${JOB_WORDS[thread.job.status] || thread.job.status}${progress}`;
		},
		taskNote(thread) {
			const job = thread?.job;
			if (!job) return "";
			if (job.status === "needs_you") return job.question?.text || "";
			if (job.status === "stopped") return job.error || job.note || "";
			if (job.status === "done") return firstLine(job.result) || job.note || "";
			return job.note || "";
		},
		taskMeta(thread) {
			return [thread.model ? this.modelName(thread.model) : "", `since ${this.timeOf(new Date(thread.createdAt))}`].filter(Boolean).join(", ");
		},
		doneLine(thread) {
			return this.taskNote(thread) || JOB_WORDS[thread.job?.status] || "";
		},
		/* "Today 10:45", "Yesterday", "Wed 28 Oct": when something was made or saved. */
		dateWhen(iso) {
			if (!iso) return "";
			const date = new Date(iso);
			const diff = Math.round((new Date(dayKey(date)) - new Date(dayKey(this.now))) / 86_400_000);
			if (diff === 0) return `today ${this.timeOf(date)}`;
			if (diff === -1) return "yesterday";
			return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).replace(",", "");
		},
		/* "10:45" today, "Tomorrow 07:30", "Sat 09:00"; past days without the time unless asked. */
		shortWhen(iso, withTime = false) {
			if (!iso) return "";
			const date = new Date(iso);
			const diff = Math.round((new Date(dayKey(date)) - new Date(dayKey(this.now))) / 86_400_000);
			if (diff === 0) return this.timeOf(date);
			const day = diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : date.toLocaleDateString("en-GB", { weekday: "short" });
			return withTime || diff > 0 ? `${day} ${this.timeOf(date)}` : day;
		},

		/* Each thread's cat (components/cats.js), in the mood its job is in. */
		catState(thread) {
			if (!thread || thread.readOnly) return "done";
			const status = thread.job?.status;
			if (status === "needs_you") return "asking";
			if (status === "queued" || status === "working" || status === "waiting" || this.streaming?.threadId === thread.id) return "working";
			if (status === "stopped") return "stopped";
			return "done";
		},
		drawCat(element, seed, state) {
			// The assistant's chat has the cat chosen for it.
			window.RemindMeCats?.render(element, seed === FEED ? this.assistant.cat : seed, state);
		},
		get lastAssistantId() {
			return [...(this.open?.messages || [])].reverse().find((message) => message.role === "assistant")?.id;
		},

		progressOf(thread) {
			const progress = thread.job?.progress;
			return progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
		},

		taskLine(task) {
			const next = task.nextRun ? `Next ${this.formatWhen(task.nextRun)}` : "";
			return [next, task.lastStatus === "error" ? "the last run failed" : task.lastSummary].filter(Boolean).join(" · ");
		},

		verbFor(message) {
			const word = String(message || "").split(" ")[0];
			return VERBS.has(word) ? word : "Do it";
		},

		/*
		 * Inside Home Assistant's app panel (the sidebar, or the Home Assistant
		 * app on a phone): Home Assistant tells it which thread a notification
		 * link names (/app/<slug>/t/<id>), and on a phone hides its own header
		 * so RemindMe fills the screen; ☰ opens Home Assistant's menu instead.
		 */
		joinHomeAssistant() {
			if (window.parent === window) return;
			let asked = false;
			window.addEventListener("message", (event) => {
				if (event.source !== window.parent || event.data?.type !== "home-assistant/properties") return;
				this.haNarrow = Boolean(event.data.narrow);
				if (this.haNarrow && !asked) {
					asked = true;
					window.parent.postMessage({ type: "home-assistant/subscribe-properties", kioskMode: true }, "*");
				}
				const thread = /^\/t\/([\w-]+)/.exec(event.data.route?.path || "")?.[1];
				if (thread && thread !== this.haLinked) {
					this.haLinked = thread;
					this.openThread(thread);
				}
			});
			window.parent.postMessage({ type: "home-assistant/subscribe-properties" }, "*");
		},
		haMenu() {
			window.parent.postMessage({ type: "home-assistant/toggle-menu" }, "*");
		},

		/* ── Tabs, and a task's page ─────────────────────────────────── */

		/*
		 * The address says what shows: nothing (or #t/remindme) is the chat,
		 * #tasks and #made the other tabs, #t/<id> a task's page under Tasks.
		 * A notification opens its task by changing the address.
		 */
		route() {
			const hash = location.hash;
			const thread = hash.match(/^#t\/([\w-]+)$/)?.[1];
			if (thread && thread !== FEED) {
				this.tab = "tasks";
				this.showThread(thread);
				this.loadTab("tasks");
				return;
			}
			const tab = TABS.find((name) => hash === `#${name}`) || "chat";
			this.tab = tab;
			if (tab === "chat") {
				if (!this.open?.feed) this.open = null;
				this.showFeed();
			} else {
				this.open = null;
				this.loadTab(tab);
			}
		},
		goTab(tab) {
			const onPage = this.tab === "tasks" && this.open && !this.open.feed;
			if (tab === this.tab && !onPage) {
				document.querySelector(tab === "chat" ? ".rm-messages" : `.rm-${tab} .rm-scroll`)?.scrollTo({ top: tab === "chat" ? 1e9 : 0, behavior: "smooth" });
				return;
			}
			history.replaceState(null, "", tab === "chat" ? location.pathname + location.search : `#${tab}`);
			this.open = tab === "chat" ? this.open : null;
			this.route();
		},
		async loadTab(tab) {
			if (tab === "tasks") await Promise.all([this.loadUpcoming(), this.loadSection("prices")]);
			if (tab === "made") await this.loadMade();
		},

		openThread(id) {
			if (id === FEED) return this.goTab("chat");
			if (this.open?.id === id) return;
			this.openedFrom = this.historyOpen ? "history" : this.tab;
			history.pushState({ thread: id }, "", `#t/${id}`);
			this.tab = "tasks";
			this.showThread(id);
		},

		async showThread(id) {
			if (id === FEED) return this.showFeed();
			const thread = await this.getJson(`./api/threads/${encodeURIComponent(id)}`, null);
			if (!thread) {
				this.error = "That conversation is gone.";
				this.closeThread();
				return;
			}
			this.open = thread;
			this.replyDraft = "";
			this.scrollMessages();
		},

		/*
		 * RemindMe's thread: its own messages (from the activity log) and the
		 * replies to it, by day, with older days folded and each message's buttons.
		 */
		async showFeed(quiet = false) {
			const data = await this.getJson("./api/feed", null);
			if (!data) {
				this.error = "RemindMe's thread didn't load.";
				return;
			}
			if (quiet && this.open?.id !== FEED) return;
			this.open = this.feedView(data);
			this.feedSeen = Date.now();
			try {
				localStorage.setItem("rm-feed-seen", String(this.feedSeen));
			} catch {
				/* private browsing: it just counts again */
			}
			if (!quiet) this.scrollMessages();
		},
		feedView(data) {
			// A task's news shows above its card; only its newest one offers the answers.
			const latest = new Map();
			for (const entry of data.entries || []) if (entry.threadId && (!latest.has(entry.threadId) || entry.at > latest.get(entry.threadId).at)) latest.set(entry.threadId, entry);
			const notes = (data.entries || []).map((entry) => {
				const task = entry.threadId ? this.taskOf(entry.threadId) : undefined;
				const title = task?.title || "";
				// A task's news comes from the task: its title and cat on top, its options as buttons rather than a list.
				const said = entry.threadId ? (title && entry.text.startsWith(`${title}: `) ? entry.text.slice(title.length + 2) : entry.text).replace(/(\n• [^\n]*)+\s*$/, "") : entry.text;
				return {
					id: `e-${entry.id}`,
					role: "assistant",
					at: entry.at,
					// The news shows as its stories card; its text stays for Discord and the phone.
					text: entry.receipts?.length ? "" : entry.embeds?.some((embed) => embed.kind === "stories") ? `**${firstLine(entry.text)}**` : said,
					receipts: entry.receipts,
					embeds: entry.embeds,
					entry,
					from: entry.threadId ? { id: entry.threadId, title: title || "A task", latest: latest.get(entry.threadId) === entry } : undefined,
					bad: entry.kind === "failed",
					meta: `${this.timeOf(new Date(entry.at))}${CHANNEL_NOTES[entry.channel] ? ` · ${CHANNEL_NOTES[entry.channel]}` : ""}`,
				};
			});
			// A task an answer started shows as its card, not as a receipt line.
			const said = (data.thread?.messages || [])
				.filter((message) => message.role !== "step")
				.map((message) =>
					message.receipts?.some((receipt) => receipt.job)
						? { ...message, receipts: message.receipts.filter((receipt) => !receipt.job), jobs: message.receipts.filter((receipt) => receipt.job).map((receipt) => ({ id: receipt.job, title: receipt.text.replace(/^Started a job: /, "") })) }
						: message,
				);
			const all = [...notes, ...said].sort((a, b) => a.at.localeCompare(b.at));
			const today = dayKey(this.now);
			const yesterday = dayKey(new Date(this.now.getTime() - 86_400_000));
			const recent = all.filter((message) => [today, yesterday].includes(dayKey(new Date(message.at))));
			const older = all.length - recent.length;
			const messages = [];
			if (this.feedFold && older) messages.push({ id: "fold", role: "fold", at: "", text: `Show ${older} earlier message${older === 1 ? "" : "s"}` });
			let day = "";
			for (const message of this.feedFold ? recent : all) {
				const key = dayKey(new Date(message.at));
				if (key !== day) {
					day = key;
					messages.push({ id: `day-${key}`, role: "day", at: message.at, text: key === today ? "Today" : key === yesterday ? "Yesterday" : new Date(message.at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) });
				}
				messages.push(message);
			}
			return { id: FEED, feed: true, title: this.assistant.name, createdAt: all[0]?.at || new Date().toISOString(), updatedAt: all.at(-1)?.at || "", messages, model: data.thread?.model, answered: said.some((message) => message.role === "assistant") };
		},
		async unfoldFeed() {
			this.feedFold = false;
			await this.showFeed(true);
		},
		/* A button under one of RemindMe's messages: it does its thing, and the message says what came of it. */
		async feedAct(message, index) {
			try {
				message.entry = await this.request(`./api/activity/${encodeURIComponent(message.entry.id)}/act/${index}`);
				await this.loadInbox();
			} catch (error) {
				this.error = error.message;
			}
		},

		/* ── Picking the model for a thread, a new request or the news ─── */

		async loadModelChoices() {
			this.modelChoices = await this.getJson("./api/ai/choices", { default: null, groups: [] });
		},
		modelValue(choice) {
			return choice ? `${choice.provider}|${choice.model}` : "";
		},
		modelOf(value) {
			const at = value.indexOf("|");
			return at > 0 ? { provider: value.slice(0, at), model: value.slice(at + 1) } : null;
		},
		modelName(choice) {
			if (!choice) return this.defaultModelLabel();
			const group = this.modelChoices.groups.find((entry) => entry.provider === choice.provider);
			return group?.models.find((model) => model.id === choice.model)?.name || choice.model;
		},
		/* Once a chat has an answer it keeps its AI: only that provider's models are offered. */
		threadLocked(thread) {
			return Boolean(thread?.model && (thread.feed ? thread.answered : thread.messages?.some((message) => message.role === "assistant")));
		},
		threadModelGroups(thread) {
			const groups = this.modelChoices.groups;
			return this.threadLocked(thread) ? groups.filter((group) => group.provider === thread.model.provider) : groups;
		},
		defaultModelLabel() {
			return this.modelChoices.default ? `Default · ${this.modelChoices.default.name}` : "Default";
		},
		async setThreadModel(value) {
			const thread = this.open;
			if (!thread) return;
			const model = this.modelOf(value);
			try {
				await this.request(`./api/threads/${encodeURIComponent(thread.id)}`, "PATCH", { model });
				if (this.open?.id === thread.id) this.open = { ...this.open, model: model || undefined };
				this.showToast(model ? `${this.modelName(model)} answers here from now on.` : `Back to the default, ${this.modelChoices.default?.name || "the AI under Settings"}.`);
			} catch (error) {
				this.error = error.message;
			}
		},

		/* ── The daily news ────────────────────────────────────────────── */

		newsGroups() {
			const groups = [
				["Germany", "From Germany"],
				["Europe", "European"],
				["International", "International"],
			];
			return groups.map(([from, label]) => ({ label, sources: this.news.catalog.filter((source) => source.from === from) })).filter((group) => group.sources.length);
		},
		sourceLine(source) {
			return [{ de: "German", en: "English" }[source.language], source.covers, source.note].filter(Boolean).join(" · ");
		},
		async saveNews(patch, note = "Saved.") {
			try {
				this.news = await this.request("./api/news", "PUT", patch);
				this.newsNote = note;
			} catch (error) {
				this.newsNote = error.message;
				await this.loadSection("news");
			}
		},
		toggleNewsSource(id, on) {
			const sources = on ? [...this.news.sources, id] : this.news.sources.filter((source) => source !== id);
			return this.saveNews({ sources }, sources.length ? "Saved." : "No source ticked: the digest uses the five suggested ones until you tick some.");
		},
		/* A feed added here is a feed connector that's in the news, without new-post notices. */
		async addNewsFeed() {
			this.newsBusy = true;
			this.newsNote = "";
			try {
				const data = await this.request("./api/connectors", "POST", { kind: "feed", values: { url: this.newFeed.trim(), news: "on", alerts: "off" } });
				this.newsNote = `${data.connector.name} added under Your feeds, and ticked. It's under Connectors too.`;
				this.newFeed = "";
				await this.loadSection("news");
			} catch (error) {
				this.newsNote = `Not added: ${error.message}`;
			} finally {
				this.newsBusy = false;
			}
		},
		async toggleOwnFeed(feed, on) {
			try {
				await this.request(`./api/connectors/${encodeURIComponent(feed.id)}`, "PATCH", { values: { news: on ? "on" : "off" } });
				this.newsNote = on ? `${feed.name} is in the news.` : `${feed.name} is out of the news.`;
			} catch (error) {
				this.newsNote = error.message;
			}
			await this.loadSection("news");
		},
		feedHost(url) {
			try {
				return new URL(url).hostname.replace(/^www\./, "");
			} catch {
				return url;
			}
		},
		async sendNewsNow() {
			this.newsBusy = true;
			this.newsNote = "Reading the headlines and writing it up. This takes up to a minute.";
			try {
				const result = await this.request("./api/news/send", "POST", {});
				this.newsNote = result.plain ? `Sent as headlines only, because ${result.plain}.` : `Sent: ${result.stories} stories, in the RemindMe thread, on Discord and on your phone.`;
				if (result.problems?.length) this.newsNote += ` Not reached: ${result.problems.join(", ")}.`;
			} catch (error) {
				this.newsNote = error.message;
			} finally {
				this.newsBusy = false;
				await this.loadSection("news");
			}
		},

		/* ── Price watches ─────────────────────────────────────────────── */

		priceLine(watch) {
			if (watch.price === undefined) return watch.error ? `Not read: ${watch.error}` : "Not read yet";
			const lowest = watch.lowest && watch.lowest.price < watch.price ? ` · lowest ${euro(watch.lowest.price)}` : "";
			return `${euro(watch.price)}${watch.shop ? ` at ${watch.shop}` : ""}${lowest} · checked ${this.formatWhen(watch.lastCheck)}`;
		},
		/* A target as typed back into its field: "180", "45,50". */
		targetText(target) {
			if (!target) return "";
			return (Number.isInteger(target) ? String(target) : target.toFixed(2)).replace(".", ",");
		},
		/* The price over time, as a small line: built as SVG elements, never as HTML. */
		drawPriceLine(element, history) {
			element.replaceChildren();
			const points = (history || []).map((point) => point.price);
			if (points.length < 2) return;
			const low = Math.min(...points);
			const high = Math.max(...points);
			const spread = high - low || 1;
			const ns = "http://www.w3.org/2000/svg";
			const svg = document.createElementNS(ns, "svg");
			svg.setAttribute("viewBox", "0 0 100 24");
			svg.setAttribute("preserveAspectRatio", "none");
			svg.setAttribute("aria-hidden", "true");
			const line = document.createElementNS(ns, "polyline");
			line.setAttribute("points", points.map((price, index) => `${((index / (points.length - 1)) * 100).toFixed(1)},${(22 - ((price - low) / spread) * 20).toFixed(1)}`).join(" "));
			line.setAttribute("fill", "none");
			line.setAttribute("stroke", "currentColor");
			line.setAttribute("stroke-width", "1.5");
			line.setAttribute("vector-effect", "non-scaling-stroke");
			svg.append(line);
			element.append(svg);
		},
		async addPriceWatch() {
			const what = this.newPrice.what.trim();
			const target = euroNumber(this.newPrice.target);
			this.priceBusy = true;
			this.priceNote = "";
			try {
				const watch = await this.request("./api/prices", "POST", { ...(/^https?:\/\//i.test(what) ? { url: what } : { query: what }), ...(target ? { target } : {}) });
				this.newPrice = { what: "", target: "" };
				this.priceNote = `Watching ${watch.name}: ${euro(watch.price)}${watch.shop ? ` at ${watch.shop}` : ""} now.`;
				await this.loadSection("prices");
			} catch (error) {
				this.priceNote = `Not added: ${error.message}`;
			} finally {
				this.priceBusy = false;
			}
		},
		async checkPriceWatch(watch) {
			this.priceNote = `Checking ${watch.name}`;
			const fresh = await this.request(`./api/prices/${encodeURIComponent(watch.id)}/check`).catch((error) => ({ error: error.message }));
			this.priceNote = fresh.price !== undefined ? `${watch.name}: ${euro(fresh.price)}${fresh.shop ? ` at ${fresh.shop}` : ""}.` : `Couldn't read it: ${fresh.error}`;
			await this.loadSection("prices");
		},
		async setPriceTarget(watch, value) {
			const target = euroNumber(value);
			try {
				await this.request(`./api/prices/${encodeURIComponent(watch.id)}`, "PATCH", { target: target || null });
				this.priceNote = target ? `You'll hear when ${watch.name} is ${euro(target)} or less.` : `You'll hear when ${watch.name} drops by 5 % or more.`;
			} catch (error) {
				this.priceNote = error.message;
			}
			await this.loadSection("prices");
		},
		async removePriceWatch(watch) {
			await fetch(`./api/prices/${encodeURIComponent(watch.id)}`, { method: "DELETE" });
			this.priceNote = `Stopped watching ${watch.name}.`;
			await this.loadSection("prices");
		},

		/* ── What a change did, and taking it back ───────────────────── */

		showToast(text, undo) {
			clearTimeout(this.toastTimer);
			// Kept off the reactive object: Alpine calls a function an expression hands it.
			this.toastUndo = undo;
			this.toast = { text, canUndo: Boolean(undo) };
			this.toastTimer = setTimeout(() => (this.toast = null), 5_000);
		},
		async undoToast() {
			const undo = this.toastUndo;
			this.toastUndo = undefined;
			this.toast = null;
			await undo?.();
			await this.loadInbox();
		},
		async unarchive(thread) {
			await this.request(`./api/threads/${encodeURIComponent(thread.id)}`, "PATCH", { archived: false }).catch((error) => (this.error = error.message));
			if (this.open?.id === thread.id) this.open = { ...this.open, archivedAt: undefined };
			await this.loadInbox();
		},

		/* Back from a task's page: to where it was opened from. */
		closeThread() {
			if (history.state?.thread) history.back();
			else {
				history.replaceState(null, "", this.openedFrom === "chat" ? location.pathname + location.search : "#tasks");
				this.open = null;
				this.route();
			}
		},

		async refreshThread() {
			const open = this.open;
			if (!open || open.readOnly) return;
			if (open.feed) return this.showFeed(true);
			const fresh = await this.getJson(`./api/threads/${encodeURIComponent(open.id)}`, null);
			if (!fresh || this.open?.id !== fresh.id || this.streaming) return;
			const box = document.querySelector(".rm-messages");
			const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80;
			const changed = fresh.updatedAt !== open.updatedAt;
			this.open = fresh;
			if (changed) {
				if (atBottom) this.scrollMessages();
				if (fresh.job?.status !== open.job?.status) this.loadInbox();
			}
		},

		threadLine(thread) {
			if (thread.readOnly) return thread.meta;
			if (thread.feed) return "Your chat, and what it did on its own";
			const model = thread.model ? `${this.modelName(thread.model)}, ` : "";
			if (thread.archivedAt) return `Archived, started ${this.formatWhen(thread.createdAt)}`;
			if (!thread.job) return `${model}started ${this.formatWhen(thread.createdAt)}`;
			return `${this.taskState(thread)}. ${model}started ${this.formatWhen(thread.createdAt)}`;
		},

		isRunning(thread) {
			return Boolean(thread && !thread.readOnly && (["queued", "working"].includes(thread.job?.status) || this.streaming?.threadId === thread.id));
		},

		/* The held actions a message left behind that still wait for a tap. */
		pendingIn(message) {
			return (message.confirms || []).map((item) => this.waiting.find((waiting) => waiting.token === item.token)).filter(Boolean);
		},

		scrollMessages() {
			this.$nextTick(() => {
				const box = document.querySelector(".rm-messages");
				if (box) box.scrollTop = box.scrollHeight;
			});
		},

		renderEmbeds(element, embeds) {
			if (window.RemindMeEmbeds) window.RemindMeEmbeds.render(element, embeds || []);
		},
		renderText(element, text) {
			element.replaceChildren();
			if (!text) return;
			if (window.RemindMeRichText) window.RemindMeRichText.render(element, text);
			else element.textContent = text;
		},

		/* ── Sending ─────────────────────────────────────────────────── */

		attach(event) {
			for (const file of event.target.files || []) {
				if (this.pictures.length >= 4) break;
				if (file.size > 6_000_000) {
					this.error = `${file.name} is bigger than 6 MB.`;
					continue;
				}
				const reader = new FileReader();
				reader.onload = () => this.pictures.push({ name: file.name, mediaType: file.type, dataUrl: String(reader.result) });
				reader.readAsDataURL(file);
			}
			event.target.value = "";
		},

		/* A message in the chat, with its pictures. Work that takes a while comes back as a task's card. */
		async send() {
			const text = this.draft.trim();
			if ((!text && !this.pictures.length) || this.sending || !this.open?.feed) return;
			const attachments = this.pictures;
			this.draft = "";
			this.pictures = [];
			const at = new Date().toISOString();
			this.open.messages = [...this.open.messages, { id: `local-${Date.now()}`, role: "user", at, text: text || "(picture)" }];
			await this.stream(`./api/threads/${FEED}/messages`, { message: text, attachments }, false);
		},

		async reply() {
			const open = this.open;
			const text = this.replyDraft.trim();
			if (!open || open.readOnly || !text || this.sending) return;
			this.replyDraft = "";
			// A job takes the reply as an answer and carries on in the background.
			if (open.job) {
				try {
					this.open = await this.request(`./api/threads/${encodeURIComponent(open.id)}/messages`, "POST", { message: text });
					this.scrollMessages();
				} catch (error) {
					this.error = error.message;
				}
				await this.loadInbox();
				return;
			}
			open.messages = [...open.messages, { id: `local-${Date.now()}`, role: "user", at: new Date().toISOString(), text }];
			await this.stream(`./api/threads/${encodeURIComponent(open.id)}/messages`, { message: text }, false);
		},

		async answerJob(thread, option) {
			try {
				const fresh = await this.request(`./api/threads/${encodeURIComponent(thread.id)}/messages`, "POST", { message: option });
				if (this.open?.id === thread.id) {
					this.open = fresh;
					this.scrollMessages();
				}
			} catch (error) {
				this.error = error.message;
			}
			await this.loadInbox();
		},

		async stream(url, body, fresh) {
			this.sending = this.busy = true;
			this.error = "";
			this.abort = new AbortController();
			let threadId = fresh ? null : this.open?.id;
			this.streaming = { threadId, status: "thinking", text: "" };
			this.scrollMessages();
			try {
				const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: this.abort.signal });
				if (!response.ok || !response.body) {
					const data = await response.json().catch(() => ({}));
					throw new Error(data.error || "RemindMe didn't start answering.");
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let event = "";
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					buffer += decoder.decode(chunk.value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.startsWith("event: ")) event = line.slice(7);
						if (!line.startsWith("data: ")) continue;
						const data = JSON.parse(line.slice(6));
						if (event === "thread") {
							threadId = data.id;
							this.streaming.threadId = data.id;
							if (fresh) {
								const at = new Date().toISOString();
								this.open = { id: data.id, title: data.title, createdAt: at, updatedAt: at, messages: [{ id: "local-user", role: "user", at, text: body.message || "(picture)" }] };
								history.pushState({ thread: data.id }, "", `#t/${data.id}`);
							}
						} else if (event === "tool_start") this.streaming.status = TOOL_WORDS[String(data.name || "").split(" ")[0]] || "working";
						else if (event === "answer_delta") {
							this.streaming.status = "answering";
							this.streaming.text += data.text || "";
						} else if (event === "error") throw new Error(data.message);
						this.scrollMessages();
					}
				}
			} catch (error) {
				if (error.name !== "AbortError") this.error = error.message || String(error);
			} finally {
				this.sending = this.busy = false;
				this.abort = null;
				this.streaming = null;
				if (threadId && (!this.open || this.open.id === threadId)) await this.showThread(threadId);
				await this.loadInbox();
				// A task the answer started has its card now; draw the chat again with it.
				if (this.open?.feed) await this.showFeed(true);
			}
		},

		async stopJob(thread) {
			if (this.streaming?.threadId === thread.id) {
				this.abort?.abort();
				return;
			}
			try {
				this.open = await this.request(`./api/threads/${encodeURIComponent(thread.id)}/stop`);
			} catch (error) {
				this.error = error.message;
			}
			await this.loadInbox();
		},

		async deleteThread(thread) {
			if (!window.confirm(`Delete "${thread.title}"? It goes from the inbox; what RemindMe did stays in History.`)) return;
			await fetch(`./api/threads/${encodeURIComponent(thread.id)}`, { method: "DELETE" });
			this.closeThread();
			await this.loadInbox();
		},

		/* ── Waiting on you ──────────────────────────────────────────── */

		async request(url, method = "POST", body = {}) {
			const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const data = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
			return data;
		},

		async confirm(item) {
			try {
				await this.request("./api/confirm", "POST", { token: item.token });
			} catch (error) {
				this.error = `${item.message}: ${error.message}`;
			}
			await this.loadInbox();
		},

		async cancelWait(item) {
			await this.request("./api/confirm/cancel", "POST", { token: item.token }).catch(() => {});
			await this.loadInbox();
		},

		/* "Remind me Saturday" (10:00) or "Got it": the card says what happened, then goes. */
		async batteryAction(item, action) {
			const at = new Date(this.now);
			at.setDate(at.getDate() + ((6 - at.getDay() + 7) % 7 || 7));
			at.setHours(10, 0, 0, 0);
			item.busy = true;
			try {
				const data = await this.request(`./api/batteries/${encodeURIComponent(item.entityId)}/${action}`, "POST", action === "remind" ? { at: at.toISOString() } : {});
				item.done = data.text;
				setTimeout(() => {
					this.batteries = this.batteries.filter((entry) => entry.entityId !== item.entityId);
				}, 2500);
			} catch (error) {
				item.busy = false;
				this.error = error.message;
			}
		},

		/* ── History: the ledger ─────────────────────────────────────── */

		async openHistory(filter) {
			if (filter) this.filter = filter;
			this.historyOpen = true;
			await this.loadHistory();
		},
		/* ── Made: what it wrote, and what it remembers ─────────────── */

		async loadMade() {
			const [documents, notes, memory] = await Promise.all([this.getJson("./api/artifacts", []), this.getJson("./api/vault?tag=memory", []), this.getJson("./api/memory", { learn: true, facts: [] })]);
			this.documents = documents.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
			this.notes = notes;
			this.memory = memory;
			this.madeLoaded = true;
		},
		get madeChips() {
			return [
				{ id: "all", label: "All" },
				{ id: "doc", label: "Documents" },
				{ id: "note", label: "Remembered" },
			];
		},
		get madeItems() {
			const kinds = { html: "Page", svg: "Picture", markdown: "Document", code: "Code", glsl: "Shader", wgsl: "Shader", three: "3D scene", lua: "Script" };
			const items = [
				...this.documents.map((doc) => ({ key: `d-${doc.id}`, kind: "doc", at: doc.updatedAt, title: doc.title, text: doc.snippet || "", when: `${kinds[doc.kind] || "Document"}, ${this.dateWhen(doc.updatedAt)}`, href: `./api/artifacts/${encodeURIComponent(doc.id)}/document` })),
				...this.notes.map((note) => ({ key: `n-${note.path}`, kind: "note", at: note.updatedAt, title: note.title, text: note.snippet || "", when: `Saved ${this.dateWhen(note.updatedAt)}` })),
				...(this.memory.facts || []).map((fact) => ({ key: `f-${fact.id}`, kind: "note", at: fact.at, title: fact.text, text: "", when: `${fact.source === "you" ? "Added by you" : "Learned"} ${this.dateWhen(fact.at)}` })),
			];
			return items.filter((item) => this.madeFilter === "all" || item.kind === this.madeFilter).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
		},
		get madeEmpty() {
			if (this.madeFilter === "doc") return `No documents yet. Ask ${this.assistant.name} to write one, such as a packing list or a comparison.`;
			if (this.madeFilter === "note") return `Nothing remembered yet. Tell ${this.assistant.name} "remember that…", or add something under Settings, Memory.`;
			return `Nothing yet. What ${this.assistant.name} writes for you and what it remembers shows up here.`;
		},

		/* What's coming up, for the Tasks tab: the same list History has. */
		async loadUpcoming() {
			const data = await this.getJson("./api/ledger", null);
			if (!data) return;
			this.upcoming = data.upcoming || [];
			this.entries = data.entries || [];
		},

		async loadHistory() {
			const data = await this.getJson("./api/ledger", null);
			if (!data) return;
			this.upcoming = data.upcoming || [];
			this.entries = data.entries || [];
			this.now = new Date(data.now || Date.now());
		},

		async cancelReminder(row) {
			await fetch(`./api/reminders/${encodeURIComponent(row.reminderId)}`, { method: "DELETE" });
			await this.loadHistory();
		},

		get clock() {
			return `${pad(this.now.getHours())}:${pad(this.now.getMinutes())}`;
		},

		get emptyText() {
			if (this.filter === "coming") return "Nothing planned for the next day or so.";
			if (this.filter === "did") return "RemindMe hasn't changed anything this week.";
			if (this.filter === "messages") return "No messages this week.";
			return "Nothing yet. Ask RemindMe something, or wait for the morning brief.";
		},

		dayLabel(date) {
			const diff = Math.round((new Date(dayKey(date)) - new Date(dayKey(this.now))) / 86_400_000);
			const long = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
			if (diff === 0) return `Today, ${long}`;
			if (diff === 1) return `Tomorrow, ${long}`;
			if (diff === -1) return `Yesterday, ${long}`;
			return long;
		},

		timeOf(date) {
			return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
		},

		formatWhen(iso) {
			if (!iso) return "";
			const date = new Date(iso);
			return `${this.dayLabel(date).split(",")[0]} ${this.timeOf(date)}`;
		},

		futureRows() {
			return this.upcoming.map((item, index) => {
				const at = new Date(item.at);
				const until = item.until ? ` until ${this.timeOf(new Date(item.until))}` : "";
				return { type: "row", key: `up-${index}-${item.at}`, at, time: item.place ? "place" : item.allDay ? "all day" : this.timeOf(at), kind: item.kind, text: `${item.text}${until}`, css: "future", reminderId: item.reminderId };
			});
		},

		pastRows() {
			return this.entries.map((entry) => {
				const at = new Date(entry.at);
				return {
					type: "row",
					key: entry.id,
					at,
					time: this.timeOf(at),
					kind: KIND_LABELS[entry.kind] || entry.kind,
					group: entry.kind,
					question: entry.question,
					// A change shows as its receipt, with the lamp's colour; the text would repeat it.
					text: entry.receipts?.length ? "" : entry.text,
					receipts: entry.receipts,
					via: CHANNEL_NOTES[entry.channel] || "",
					css: entry.kind,
				};
			});
		},

		get view() {
			const future = this.filter === "all" || this.filter === "coming" ? this.futureRows() : [];
			let past = this.filter === "coming" ? [] : this.pastRows();
			if (this.filter === "did") past = past.filter((row) => ["did", "confirmed", "cancelled", "waiting"].includes(row.group));
			if (this.filter === "messages") past = past.filter((row) => ["answered", "sent", "failed"].includes(row.group));
			// Newest first: the future counts down to now, then the past goes back from it.
			future.sort((a, b) => b.at - a.at);
			const items = [];
			let day = "";
			const heading = (date) => {
				const key = dayKey(date);
				if (key === day) return;
				day = key;
				items.push({ type: "day", key: `day-${key}`, label: this.dayLabel(date) });
			};
			for (const row of future) {
				heading(row.at);
				items.push(row);
			}
			heading(this.now);
			items.push({ type: "now", key: "now" });
			for (const row of past) {
				heading(row.at);
				items.push(row);
			}
			return items;
		},

		/* ── Settings ────────────────────────────────────────────────── */

		/*
		 * Settings open on the list on a phone, and on AI on a computer, where the
		 * list stays alongside. Every section's line comes from loading them all.
		 */
		async openSettings(tab) {
			this.settingsTab = tab || (this.phoneLayout ? null : this.settingsTab || "ai");
			this.settingsOpen = true;
			await Promise.allSettled(this.sections.map((section) => this.loadSection(section.id)));
		},
		async showSection(id) {
			this.settingsTab = id;
			document.querySelector(".rm-sheet")?.scrollTo?.(0, 0);
			await this.loadSection(id);
		},
		async loadSection(tab) {
			if (tab === "ai") await this.loadAi();
			if (tab === "prompt") await this.loadPersona();
			if (tab === "rules") this.rules = await this.getJson("./api/rules", []);
			if (tab === "discord") this.discord = await this.getJson("./api/discord", this.discord);
			if (tab === "skills") this.skills = await this.getJson("./api/skills", []);
			if (tab === "mcp") this.mcpServers = await this.getJson("./api/mcp", []);
			if (tab === "tasks") this.tasks = await this.getJson("./api/tasks", []);
			if (tab === "prices") this.priceWatches = await this.getJson("./api/prices", []);
			if (tab === "news") this.news = await this.getJson("./api/news", this.news);
			if (tab === "connectors") await this.loadConnectors();
			if (tab === "phone") await Promise.all([this.loadPhone(), this.loadDictation()]);
			if (tab === "memory") this.memory = await this.getJson("./api/memory", { learn: true, facts: [] });
			if (tab === "documents") this.documents = (await this.getJson("./api/artifacts", [])).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
		},
		get settingsGroups() {
			return [...new Set(this.sections.map((section) => section.group))].map((name) => ({ name, sections: this.sections.filter((section) => section.group === name) }));
		},
		get settingsTitle() {
			return this.phoneLayout && this.settingsTab ? this.sections.find((section) => section.id === this.settingsTab)?.label || "Settings" : "Settings";
		},
		/* One line per section on what it's set to now; bad when something needs fixing. */
		sectionStatus(id) {
			const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
			if (id === "ai") return !this.ai?.ready && this.ai?.problem ? { text: this.ai.problem, bad: true } : { text: [this.ai?.label, this.ai?.model].filter(Boolean).join(" · ") || "Pick who answers" };
			if (id === "prompt") return { text: [this.assistant.name, this.lookName()].filter(Boolean).join(" · ") };
			if (id === "discord") return { text: !this.discord.bot ? "Not set up" : this.discord.messages ? "Its messages go there too" : "Only answers when you write" };
			if (id === "rules") {
				const asks = this.rules.filter((rule) => rule.choice === "ask").length;
				const off = this.rules.filter((rule) => rule.choice === "never").length;
				return { text: [`Asks first for ${asks}`, off ? `${off} off` : ""].filter(Boolean).join(" · ") };
			}
			if (id === "memory") return { text: `${this.memory.learn ? "Learning" : "Not learning"} · ${plural(this.memory.facts?.length || 0, "fact")}` };
			if (id === "skills") return { text: this.skills.length ? `${this.skills.filter((skill) => skill.enabled).length} of ${this.skills.length} on` : "None yet" };
			if (id === "connectors") {
				const failed = this.connectors.find((connector) => connector.enabled && connector.status && !connector.status.ok);
				if (failed) return { text: `${failed.name}'s last check failed`, bad: true };
				const feeds = this.feedConnectors().length;
				const parts = [this.mailConnectors().map((connector) => connector.name).join(", "), this.parcelConnectors().map((connector) => connector.name).join(", "), feeds ? plural(feeds, "feed") : ""].filter(Boolean);
				return { text: parts.length ? parts.join(" · ") : "Nothing connected yet" };
			}
			if (id === "phone") {
				const name = this.haPhone.phones.find((phone) => phone.id === this.haPhone.target)?.name;
				if (this.haPhone.target) return { text: `Through the Home Assistant app on ${name || "your phone"}` };
				if (this.phone.state === "running") {
					const count = this.phone.devices?.length || 0;
					return { text: count ? `Connected · ${count === 1 ? "1 device gets" : `${count} devices get`} notifications` : "Connected · no device gets notifications yet" };
				}
				if (this.phone.state === "needs_login") return { text: "Not connected to Tailscale yet" };
				if (this.phone.state === "off") return { text: "Off" };
				return this.phone.error ? { text: "Tailscale isn't answering", bad: true } : { text: "Starting" };
			}
			if (id === "mcp") {
				const wants = this.mcpServers.find((server) => server.wantsSignIn);
				if (wants) return { text: `${wants.name} wants you to sign in`, bad: true };
				const on = this.mcpServers.filter((server) => server.enabled);
				return { text: on.length ? on.map((server) => server.name).join(", ") : this.mcpServers.length ? "All off" : "None yet" };
			}
			if (id === "news") {
				if (!this.news.on) return { text: "Off" };
				if (this.news.lastProblem && !/^Not reached/.test(this.news.lastProblem)) return { text: this.news.lastProblem, bad: true };
				const count = this.news.sources.length;
				return { text: `Every day at ${this.news.time} · ${count} ${count === 1 ? "source" : "sources"}${this.news.writer ? ` · ${this.modelName(this.news.writer)}` : ""}` };
			}
			if (id === "prices") {
				const broken = this.priceWatches.find((watch) => watch.error && watch.price === undefined);
				if (broken) return { text: `${broken.name}: ${broken.error}`, bad: true };
				if (!this.priceWatches.length) return { text: "None yet" };
				const [first] = this.priceWatches;
				return { text: this.priceWatches.length === 1 ? `${first.name}: ${euro(first.price)}` : `${this.priceWatches.length} products, checked every few hours` };
			}
			if (id === "tasks") return { text: this.tasks.length ? `${this.tasks.slice(0, 2).map((task) => task.name).join(", ")}${this.tasks.length > 2 ? ` and ${this.tasks.length - 2} more` : ""}` : "None yet" };
			if (id === "documents") return { text: this.documents.length ? plural(this.documents.length, "document") : "None yet" };
			return { text: "" };
		},
		/* What needs fixing, on top of the list. */
		get settingsProblems() {
			return this.sections.map((section) => ({ ...section, status: this.sectionStatus(section.id) })).filter((section) => section.status.bad);
		},

		async getJson(url, fallback) {
			try {
				const response = await fetch(url, { cache: "no-store" });
				return response.ok ? await response.json() : fallback;
			} catch {
				return fallback;
			}
		},

		/* AI and sign-ins */
		async loadAi() {
			this.aiError = "";
			this.ai = { ...(this.ai || {}), ...(await this.getJson("./api/ai", {})) };
			this.loadModelChoices();
			this.aiModel = this.ai.model || "";
			this.aiEffort = this.ai.effort || "low";
			await Promise.all([this.loadAiModels(), this.loadSignins()]);
		},
		async loadAiModels() {
			this.aiModels = [];
			this.modelTable = { billing: "unknown", budget: 0, featured: [], others: [] };
			const option = this.ai?.providers?.find((entry) => entry.id === this.ai.provider);
			if (!option?.configured) return;
			const response = await fetch(`./api/ai/models?provider=${encodeURIComponent(option.id)}`);
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				this.aiError = data.error || "Could not list the models.";
				return;
			}
			this.aiModels = data.models || [];
			this.modelTable = { billing: data.billing || "unknown", budget: data.budget || 0, featured: data.featured || [], others: data.others || [] };
			// A model picked from the older list or typed in shows where it is.
			this.modelsOpen = Boolean(this.aiModel) && !this.modelTable.featured.some((model) => model.id === this.aiModel);
		},
		get aiReadyToPick() {
			return Boolean(this.ai?.providers?.find((option) => option.id === this.ai.provider)?.configured);
		},
		get modelNote() {
			if (!this.aiReadyToPick) return "Choose who answers first.";
			const using = this.aiModel && !this.modelTable.featured.some((model) => model.id === this.aiModel) ? `Using ${this.aiModel}. ` : "";
			if (this.modelTable.billing === "credits") return `${using}Cost is a typical answer at list price, paid from your API credits. Smarts and speed are a rough guide, not a benchmark.`;
			if (this.modelTable.billing === "plan") return `${using}Uses your plan's limits; nothing is billed here. Smarts and speed are a rough guide, not a benchmark.`;
			if (!this.modelTable.featured.length && !this.modelTable.others.length) return `${using}This provider doesn't list its models. Type the exact name of the one to use.`;
			return `${using}This provider doesn't tell RemindMe its prices.`;
		},
		pickModel(id) {
			const model = String(id || "").trim();
			if (!model || this.aiBusy || !this.aiReadyToPick) return;
			this.aiModel = model;
			this.customModel = "";
			this.chooseAi({ model });
		},
		centsOf(usd) {
			if (usd === undefined || usd === null) return "";
			const cents = usd * 100;
			return cents < 1 ? `${cents.toFixed(1)}¢` : `${Math.round(cents)}¢`;
		},
		planWord(level) {
			return ["", "light", "more", "most"][level] || "";
		},
		async chooseAi(change) {
			this.aiBusy = true;
			this.aiError = "";
			this.aiTest = null;
			try {
				await this.request("./api/ai", "PUT", change);
				await this.loadAi();
				await this.loadLedger();
			} catch (error) {
				this.aiError = error.message;
			} finally {
				this.aiBusy = false;
			}
		},
		async testAi() {
			this.aiBusy = true;
			this.aiTest = null;
			try {
				const data = await this.request("./api/ai/test");
				this.aiTest = data.ok ? { ok: true, reply: `Answered "${data.reply}".` } : { ok: false, error: data.error };
			} catch (error) {
				this.aiTest = { ok: false, error: error.message };
			} finally {
				this.aiBusy = false;
			}
		},
		async sendBrief() {
			this.aiBusy = true;
			this.aiTest = null;
			try {
				await this.request("./api/brief");
				this.aiTest = { ok: true, reply: "Today's brief is on its way to Discord." };
				await this.loadLedger();
			} catch (error) {
				this.aiTest = { ok: false, error: error.message };
			} finally {
				this.aiBusy = false;
			}
		},
		aiSpendLine() {
			const spend = this.ai?.spend;
			if (!spend) return "";
			const budget = this.ai.budget ? ` of the $${this.ai.budget.toFixed(2)} daily budget` : "";
			const tokens = `${Math.round((spend.inputTokens + spend.outputTokens) / 1000)}k tokens`;
			return `Today: $${spend.usd.toFixed(2)}${budget}, ${tokens}${spend.unpriced ? " (some on a model without a known price)" : ""}. Subscriptions aren't counted.`;
		},
		aiSearchLine() {
			const search = this.ai?.webSearch;
			if (search === "provider") return "Web search: built into this provider.";
			if (search === "searxng") return "Web search: through SearXNG or Exa.";
			return "Web search: off. Add a SearXNG address or an Exa key in the app options to search with the Claude Code and Codex agents.";
		},
		async loadSignins() {
			const status = {};
			for (const id of ["chatgpt", "claude"]) status[id] = await this.getJson(`./api/ai/signin/${id}`, { connected: false });
			this.signinStatus = status;
		},
		async signIn(provider) {
			this.aiBusy = true;
			this.aiError = "";
			try {
				const attempt = await this.request(`./api/ai/signin/${provider}/start`);
				this.signin = { provider, attemptId: attempt.attemptId, url: attempt.url, instructions: attempt.instructions, code: "" };
				window.open(attempt.url, "_blank", "noopener");
			} catch (error) {
				this.aiError = error.message;
			} finally {
				this.aiBusy = false;
			}
		},
		async finishSignIn() {
			if (!this.signin) return;
			this.aiBusy = true;
			this.aiError = "";
			try {
				await this.request(`./api/ai/signin/${this.signin.provider}/complete`, "POST", { attemptId: this.signin.attemptId, code: this.signin.code.trim() });
				this.signin = null;
				await this.loadAi();
			} catch (error) {
				this.aiError = error.message;
			} finally {
				this.aiBusy = false;
			}
		},
		async cancelSignIn() {
			if (this.signin) await this.request(`./api/ai/signin/${this.signin.provider}/cancel`).catch(() => {});
			this.signin = null;
		},
		async signOut(provider) {
			this.aiBusy = true;
			try {
				await this.request(`./api/ai/signin/${provider}/logout`);
				await this.loadAi();
			} catch (error) {
				this.aiError = error.message;
			} finally {
				this.aiBusy = false;
			}
		},

		/* Your assistant: its name, its cat, how it talks, and its chat */
		async loadPersona() {
			const data = await this.getJson("./api/persona", {});
			this.persona = data.prompt || "";
			this.personaStatus = "";
			this.identityFrom(data);
		},
		identityFrom(data) {
			if (!data?.name) return;
			const look = data.look || window.RemindMeCats?.parts(data.cat || FEED) || { coat: 0, accessory: 0 };
			this.identity = { name: data.name, look: { coat: look.coat, accessory: look.accessory } };
			this.assistant = { name: data.name, cat: data.cat || FEED };
		},
		/* The cat with one part changed, to show as a choice. */
		lookSeed(change) {
			const look = { ...this.identity.look, ...change };
			return `look:${look.coat}-${look.accessory}`;
		},
		get catCoats() {
			return window.RemindMeCats?.coats || [];
		},
		get catAccessories() {
			return window.RemindMeCats?.accessories || [];
		},
		get mainChatLine() {
			const model = this.threads.find((thread) => thread.id === FEED)?.model;
			const on = model ? `It answers with ${this.modelName(model)}` : "It answers with the AI chosen under AI and sign-ins";
			return `${on}. In the chat you can switch to that AI's other models; for another AI, start the chat over. What was said moves to History, and memory, reminders and jobs stay as they are.`;
		},
		lookName() {
			const cats = window.RemindMeCats;
			if (!cats) return "";
			const { coat, accessory } = this.identity.look;
			return accessory === cats.accessories.length - 1 ? cats.coats[coat] : `${cats.coats[coat]} with ${cats.accessories[accessory].toLowerCase()}`;
		},
		async saveIdentity(change, note) {
			try {
				this.identityFrom(await this.request("./api/persona", "PUT", change));
				this.persona = (await this.getJson("./api/persona", {})).prompt || this.persona;
				this.identityNote = note || "";
				if (this.open?.feed) this.open = { ...this.open, title: this.assistant.name };
			} catch (error) {
				this.identityNote = `Not saved: ${error.message}`;
			}
		},
		async renameAssistant() {
			const name = this.identity.name.trim();
			await this.saveIdentity({ name }, name ? `It's ${name} now.` : "Back to RemindMe.");
		},
		async pickLook(change) {
			this.identity.look = { ...this.identity.look, ...change };
			await this.saveIdentity({ look: this.identity.look }, "");
		},
		async restartMain() {
			if (!window.confirm(`Start your chat with ${this.assistant.name} over? What was said moves to History, and the next answer comes from the AI chosen under AI and sign-ins.`)) return;
			try {
				await this.request(`./api/threads/${FEED}/restart`);
				this.identityNote = "Started over. The old chat is in History.";
				await this.loadInbox();
				if (this.open?.feed) await this.showFeed(true);
			} catch (error) {
				this.identityNote = error.message;
			}
		},
		async savePersona() {
			this.personaStatus = "Saving";
			try {
				const data = await this.request("./api/persona", "PUT", { prompt: this.persona });
				this.persona = data.prompt || "";
				this.personaStatus = data.custom ? "Saved." : "Saved. Using the default.";
			} catch (error) {
				this.personaStatus = `Not saved: ${error.message}`;
			}
		},
		async resetPersona() {
			this.persona = "";
			await this.savePersona();
		},

		/* Skills */
		async addSkill() {
			const name = this.newSkillName.trim();
			const instructions = this.newSkillBody.trim();
			if (!name || !instructions) {
				this.skillError = "A skill needs a name and instructions.";
				return;
			}
			try {
				this.skills.unshift(await this.request("./api/skills", "POST", { name, instructions, enabled: true }));
				this.newSkillName = "";
				this.newSkillBody = "";
				this.skillError = "";
			} catch (error) {
				this.skillError = `Not saved: ${error.message}`;
			}
		},
		async updateSkill(skill, values) {
			try {
				Object.assign(skill, await this.request(`./api/skills/${encodeURIComponent(skill.id)}`, "PATCH", values));
			} catch (error) {
				this.skillError = `Not saved: ${error.message}`;
			}
		},
		async deleteSkill(skill) {
			if (!window.confirm(`Delete the skill "${skill.name}"?`)) return;
			await fetch(`./api/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" });
			this.skills = this.skills.filter((entry) => entry.id !== skill.id);
		},

		/* Connected tools (MCP) */
		async addMcp() {
			const name = this.newMcpName.trim();
			const url = this.newMcpUrl.trim();
			if (!name || !url) {
				this.mcpError = "A server needs a name and an address.";
				return;
			}
			try {
				this.mcpServers.unshift(await this.request("./api/mcp", "POST", { name, url, authorization: this.newMcpAuth.trim() || undefined, enabled: true }));
				this.newMcpName = "";
				this.newMcpUrl = "";
				this.newMcpAuth = "";
				this.mcpError = "";
				// Check it at once, so a server that wants a sign-in offers one.
				await this.testMcp(this.mcpServers[0]);
			} catch (error) {
				this.mcpError = `Not added: ${error.message}`;
			}
		},
		async updateMcp(server, values) {
			try {
				Object.assign(server, await this.request(`./api/mcp/${encodeURIComponent(server.id)}`, "PATCH", values));
			} catch (error) {
				this.mcpError = `Not saved: ${error.message}`;
			}
		},
		async testMcp(server) {
			server.probe = "Connecting";
			try {
				const data = await this.request(`./api/mcp/${encodeURIComponent(server.id)}/test`);
				server.wantsSignIn = Boolean(data.wantsSignIn);
				server.probe = data.ok ? `Connected to ${data.serverName || server.name}: ${data.tools.map((tool) => tool.name).join(", ") || "no tools"}` : data.wantsSignIn ? `${server.name} wants you to sign in: tap Sign in.` : `Failed: ${data.error}`;
			} catch (error) {
				server.probe = `Failed: ${error.message}`;
			}
		},
		async deleteMcp(server) {
			if (!window.confirm(`Remove "${server.name}"?`)) return;
			await fetch(`./api/mcp/${encodeURIComponent(server.id)}`, { method: "DELETE" });
			this.mcpServers = this.mcpServers.filter((entry) => entry.id !== server.id);
		},

		/* Phone app */
		get inPhoneApp() {
			return window.isSecureContext && !location.pathname.includes("/hassio_ingress/");
		},
		get pushPossible() {
			return this.inPhoneApp && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
		},
		get pushLine() {
			const count = this.phone.devices?.length || 0;
			const devices = count ? `${count} device${count === 1 ? " gets" : "s get"} notifications.` : "No device gets notifications yet.";
			if (this.pushOn) return `This device gets them. ${devices}`;
			if (this.pushPossible) return `${devices} Turn them on for this device below.`;
			if (this.inPhoneApp && /iPhone|iPad/.test(navigator.userAgent)) return `${devices} On an iPhone they work once RemindMe is on the home screen: open it from there and come back to this page.`;
			return `${devices} Turn them on in the phone app itself: open the address above on your phone, install it, and come back to this page there.`;
		},
		async loadPhone() {
			const [phone, ha, location] = await Promise.all([this.getJson("./api/phone", { state: "error", error: "RemindMe didn't answer." }), this.getJson("./api/phone/ha", null), this.getJson("./api/location", null)]);
			if (location) this.location = location;
			this.phone = phone;
			if (ha) this.haPhone = { phones: ha.phones || [], target: ha.target || "", liveActivities: ha.liveActivities !== false, pictures: Boolean(ha.pictures) };
			if (this.pushPossible) {
				const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
				this.pushOn = Boolean(await registration?.pushManager.getSubscription().catch(() => null));
			}
			this.pollPhone();
		},
		/* ── Dictation ─────────────────────────────────────────────────── */

		async loadDictation() {
			this.dictation = { entity: null, name: "", languages: [], hint: "", ...(await this.getJson("./api/dictation", {})) };
		},
		get canDictate() {
			const tools = window.RemindMeDictation;
			return Boolean(tools && ((this.dictation.entity && tools.canRecord()) || tools.browserCan));
		},
		/* The language asked for: the one picked here, or the closest the Pi's engine has. */
		get dictationPicked() {
			const languages = this.dictation.languages;
			const wanted = this.dictationLang.toLowerCase();
			return languages.find((language) => language.toLowerCase() === wanted) || languages.find((language) => language.toLowerCase().split("-")[0] === wanted.split("-")[0]) || languages[0] || this.dictationLang;
		},
		get dictationLine() {
			const tools = window.RemindMeDictation;
			if (this.dictation.entity && tools?.canRecord()) return `The microphone button by the text box records you, and ${this.dictation.name} in Home Assistant writes it down on the Pi. The words land in the box for you to read before sending.`;
			if (this.dictation.entity) return `${this.dictation.name} in Home Assistant can write down what you say, but this page can't use the microphone: open RemindMe over its https address (the phone app) instead.`;
			const browser = tools?.browserCan ? " Until then, the microphone button uses this browser's own speech recognition, which sends your voice to Apple or Google." : "";
			return `${this.dictation.hint || "For dictation on the Pi, add the Whisper app and its Wyoming integration in Home Assistant."}${browser}`;
		},
		chooseDictationLanguage(language) {
			this.dictationLang = language;
			try {
				localStorage.setItem("rm-dictation-lang", language);
			} catch {
				/* private browsing: it's asked again next time */
			}
		},
		async toggleDictation(target) {
			if (this.listening) return this.finishDictation();
			const tools = window.RemindMeDictation;
			if (!tools) return;
			const field = target === "reply" ? "replyDraft" : "draft";
			const before = this[field].trim();
			const put = (words) => {
				this[field] = [before, words].filter(Boolean).join(" ");
			};
			const since = Date.now();
			const tick = setInterval(() => {
				if (this.listening) this.listening.seconds = Math.round((Date.now() - since) / 1000);
			}, 500);
			const done = () => {
				clearInterval(tick);
				dictating = null;
				this.listening = null;
				this.$nextTick(() => (target === "reply" ? this.$refs.reply : this.$refs.ask)?.focus());
			};
			try {
				if (this.dictation.entity && tools.canRecord()) {
					const recorder = await tools.record(() => this.finishDictation());
					dictating = { mode: "pi", recorder, put, done };
				} else {
					const session = tools.listen(this.dictationPicked, put);
					dictating = { mode: "browser", session, put, done };
					session.done.then(put, (error) => (this.error = error.message)).finally(() => dictating?.session === session && done());
				}
				this.listening = { target, seconds: 0, busy: false };
			} catch (error) {
				done();
				this.error = error?.name === "NotAllowedError" ? "The microphone isn't allowed for RemindMe. Allow it in the phone's or browser's settings, then try again." : error?.message || String(error);
			}
		},
		async finishDictation() {
			const running = dictating;
			if (!running || this.listening?.busy) return;
			if (running.mode === "browser") return running.session.stop();
			this.listening.busy = true;
			const pcm = running.recorder.stop();
			try {
				if (pcm.length < window.RemindMeDictation.RATE * 0.4) throw new Error("That was too short to make out. Tap the microphone, speak, then tap it again.");
				const response = await fetch(`./api/dictation?language=${encodeURIComponent(this.dictationPicked)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: pcm.buffer });
				const data = await response.json().catch(() => ({}));
				if (!response.ok) throw new Error(data.error || "Dictation didn't work.");
				if (data.text) running.put(data.text);
				else this.showToast("No words came through. Try again a little closer to the phone.");
			} catch (error) {
				this.error = error.message;
			} finally {
				running.done();
			}
		},

		async setDiscordMessages(on) {
			try {
				await this.request("./api/discord", "PUT", { messages: on });
				this.discord = { ...this.discord, messages: on };
				this.discordNote = on ? "Its messages go to Discord again." : "Done. Its messages come to your phone and the RemindMe chat, not Discord.";
			} catch (error) {
				this.discordNote = error.message;
			}
		},
		ruleWord(choice) {
			return { auto: "Just do it", ask: "Ask me", never: "Never" }[choice] || choice;
		},
		async setRule(rule, choice) {
			if (rule.choice === choice) return;
			try {
				this.rules = await this.request(`./api/rules/${encodeURIComponent(rule.id)}`, "PUT", { choice });
				this.rulesNote = `${rule.label}: ${{ auto: "it does these on its own now", ask: "it asks you first now", never: "off now" }[choice]}.`;
			} catch (error) {
				this.rulesNote = error.message;
			}
		},

		/* Whose whereabouts place reminders follow */
		placeState(state) {
			return { home: "home now", not_home: "away", unknown: "not known", unavailable: "not known" }[state] || `at ${state}`;
		},
		async chooseLocation(person) {
			try {
				await this.request("./api/location", "PUT", { person });
				this.location = { ...this.location, person, chosen: person };
				this.locationNote = "Place reminders follow them now.";
			} catch (error) {
				this.locationNote = error.message;
			}
		},
		async chooseHaPhone(change) {
			try {
				const data = await this.request("./api/phone/ha", "PUT", change);
				this.haPhone = { ...this.haPhone, target: data.target, liveActivities: data.liveActivities };
				const name = this.haPhone.phones.find((option) => option.id === data.target)?.name;
				if ("target" in change) this.haNote = name ? `Notifications now come through the Home Assistant app on ${name}. Send a test to check the buttons.` : "RemindMe's own notifications are back.";
				else this.haNote = data.liveActivities ? "Running jobs show on the Lock Screen." : "No more Live Activities.";
			} catch (error) {
				this.haNote = `Not saved: ${error.message}`;
			}
		},
		async testHaPhone() {
			this.phoneBusy = true;
			try {
				await this.request("./api/phone/ha/test");
				this.haNote = "Sent. Tap a button on the phone: the notification changes to say it worked.";
			} catch (error) {
				this.haNote = error.message;
			} finally {
				this.phoneBusy = false;
			}
		},
		/* While signing in to Tailscale, the page follows along until it's connected. */
		pollPhone() {
			clearTimeout(this.phoneTimer);
			if (this.settingsOpen && this.settingsTab === "phone" && ["needs_login", "starting"].includes(this.phone.state))
				this.phoneTimer = setTimeout(() => this.loadPhone(), 3_000);
		},
		async connectPhone() {
			this.phoneBusy = true;
			try {
				this.phone = await this.request("./api/phone/connect");
				if (this.phone.authUrl) window.open(this.phone.authUrl, "_blank", "noopener");
			} catch (error) {
				this.phone = { ...this.phone, error: error.message };
			} finally {
				this.phoneBusy = false;
				this.pollPhone();
			}
		},
		copyPhoneUrl() {
			navigator.clipboard?.writeText(this.phone.url).then(() => {
				this.phoneCopied = true;
				setTimeout(() => (this.phoneCopied = false), 2_000);
			});
		},
		async enablePush() {
			this.phoneBusy = true;
			this.phoneNote = "";
			try {
				if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for RemindMe. Allow them in the phone's settings, then try again.");
				const registration = await navigator.serviceWorker.ready;
				const key = this.phone.pushKey.replace(/-/g, "+").replace(/_/g, "/");
				const raw = atob(key.padEnd(Math.ceil(key.length / 4) * 4, "="));
				const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (char) => char.charCodeAt(0)) });
				await this.request("./api/push/subscribe", "POST", { subscription: subscription.toJSON() });
				this.pushOn = true;
				this.phoneNote = "Notifications are on for this device.";
				await this.loadPhone();
			} catch (error) {
				const message = error.message || String(error);
				this.phoneNote = /denied|not ?allowed/i.test(`${error.name} ${message}`)
					? "The browser refused notifications. On an iPhone, open RemindMe from the home screen first; elsewhere, allow notifications for this site in the browser's settings."
					: message;
			} finally {
				this.phoneBusy = false;
			}
		},
		async disablePush() {
			this.phoneBusy = true;
			try {
				const registration = await navigator.serviceWorker.getRegistration();
				const subscription = await registration?.pushManager.getSubscription();
				if (subscription) {
					await this.request("./api/push/unsubscribe", "POST", { endpoint: subscription.endpoint });
					await subscription.unsubscribe();
				}
				this.pushOn = false;
				this.phoneNote = "Notifications are off for this device.";
				await this.loadPhone();
			} catch (error) {
				this.phoneNote = error.message || String(error);
			} finally {
				this.phoneBusy = false;
			}
		},
		async testPush() {
			try {
				const data = await this.request("./api/push/test");
				this.phoneNote = data.reached ? `Sent to ${data.reached} device${data.reached === 1 ? "" : "s"}.` : "No device took it. Turn notifications on again on the phone.";
			} catch (error) {
				this.phoneNote = error.message;
			}
		},

		/* Memory */
		async addMemory() {
			const text = this.newMemory.trim();
			if (!text) return;
			try {
				this.memory = await this.request("./api/memory", "POST", { text });
				this.newMemory = "";
				this.memoryNote = "Remembered.";
			} catch (error) {
				this.memoryNote = error.message;
			}
		},
		async forgetFact(fact) {
			this.memory = await this.request(`./api/memory/${encodeURIComponent(fact.id)}`, "DELETE").catch(() => this.memory);
			this.memoryNote = "Forgotten.";
		},
		async forgetAll() {
			if (!window.confirm("Forget everything RemindMe remembers about you?")) return;
			this.memory = await this.request("./api/memory", "DELETE").catch(() => this.memory);
			this.memoryNote = "Forgot everything.";
		},
		async setLearning(learn) {
			this.memory = await this.request("./api/memory/settings", "PUT", { learn }).catch(() => this.memory);
			this.memoryNote = learn ? "It learns from what you tell it again." : "It stopped learning. What it knows stays until you forget it.";
		},

		/* Connectors */
		async loadConnectors() {
			const [data, calendars, google] = await Promise.all([
				this.getJson("./api/connectors", { kinds: [], connectors: [] }),
				this.getJson("./api/calendars", { calendars: [], newEvents: null, error: "Home Assistant's calendars didn't load." }),
				this.getJson("./api/oauth/google-app", { set: false }),
			]);
			this.googleApp = { set: Boolean(google.set), clientId: google.clientId || "", redirectUri: google.redirectUri || "", domain: google.domain || "", host: google.redirectUri ? new URL(google.redirectUri).host : "", editing: false };
			this.googleForm = { clientId: google.clientId || "", clientSecret: "" };
			this.connectorKinds = data.kinds || [];
			this.connectors = (data.connectors || []).map((connector) => ({ ...connector, newPassword: "", probe: "", editing: false }));
			this.calendars = { list: calendars.calendars || [], newEvents: calendars.newEvents || null, note: "", error: calendars.error || "" };
		},
		async chooseCalendar(entityId) {
			try {
				const data = await this.request("./api/calendars/new-events", "PUT", { entityId });
				this.calendars.newEvents = data.newEvents;
				const name = this.calendars.list.find((calendar) => calendar.entityId === data.newEvents)?.name;
				this.calendars.note = name ? `New events go to ${name}.` : "RemindMe will ask which calendar each time.";
			} catch (error) {
				this.calendars.note = `Not saved: ${error.message}`;
			}
		},
		connectorKind(id) {
			return this.connectorKinds.find((kind) => kind.id === id);
		},
		mailConnectors() {
			return this.connectors.filter((connector) => connector.kind === "mail");
		},
		parcelConnectors() {
			return this.connectors.filter((connector) => connector.kind === "parcel");
		},
		dhlLine(service) {
			const status = service.status;
			const postcode = service.values.postcode ? ` · postcode ${service.values.postcode}` : "";
			const use = status ? ` · ${status.calls} of ${status.limit} checks today` : " · not used yet";
			const problem = status && !status.ok ? ` · last check failed: ${status.error}` : "";
			return `Tracking from DHL itself${postcode}${use}${problem}`;
		},
		async addDhl() {
			this.dhlBusy = true;
			this.dhlResult = null;
			try {
				const data = await this.request("./api/connectors", "POST", { kind: "parcel", preset: "dhl", secrets: { apiKey: this.newDhl.apiKey.trim() }, values: { postcode: this.newDhl.postcode.trim() } });
				this.dhlResult = { ok: true, text: `${data.result} Tell RemindMe a tracking number, or ask it to track the parcel from a shipping email.` };
				this.newDhl = { apiKey: "", postcode: "" };
				await this.loadConnectors();
			} catch (error) {
				this.dhlResult = { ok: false, text: error.message };
			} finally {
				this.dhlBusy = false;
			}
		},
		feedConnectors() {
			return this.connectors.filter((connector) => connector.kind === "feed");
		},
		feedLine(feed) {
			const status = feed.status;
			const read = !status ? "Not read yet" : status.ok ? `${status.posts || 0} ${status.posts === 1 ? "post" : "posts"}${status.newest ? `, newest ${this.formatWhen(status.newest)}` : ""} · read ${this.formatWhen(status.at)}` : `Last read ${this.formatWhen(status.at)} failed: ${status.error}`;
			return `${this.feedHost(feed.values.url)} · ${read}`;
		},
		async addFeedConnector() {
			this.feedBusy = true;
			this.feedResult = null;
			try {
				const data = await this.request("./api/connectors", "POST", { kind: "feed", values: { url: this.newFeedLink.trim(), news: "off", alerts: "on" } });
				this.feedResult = { ok: true, text: `${data.connector.name} added. ${data.result} You'll hear about new posts; put it in the daily news with its switch.` };
				this.newFeedLink = "";
				await this.loadConnectors();
			} catch (error) {
				this.feedResult = { ok: false, text: error.message };
			} finally {
				this.feedBusy = false;
			}
		},
		presetOf(id) {
			return this.connectorKinds[0]?.presets?.find((preset) => preset.id === id);
		},
		get googleWay() {
			return this.newConnector.preset === "gmail" && this.newConnector.how === "google";
		},
		async saveGoogleApp() {
			try {
				await this.request("./api/oauth/google-app", "PUT", { clientId: this.googleForm.clientId.trim(), clientSecret: this.googleForm.clientSecret.trim() });
				await this.loadConnectors();
				this.connectorResult = { ok: true, text: "Google app saved. Now sign in with Google." };
			} catch (error) {
				this.connectorResult = { ok: false, text: error.message };
			}
		},
		async removeGoogleApp() {
			const signedIn = this.connectors.some((connector) => connector.values.auth === "google");
			if (!window.confirm(signedIn ? "Remove your Google app? Gmail accounts signed in with it stop working until you add it again." : "Remove your Google app?")) return;
			await fetch("./api/oauth/google-app", { method: "DELETE" });
			await this.loadConnectors();
		},
		/*
		 * A sign-in opens in a new tab (Safari, on an iPhone) through the link's
		 * own href, so no popup blocker stops it; this page then asks how it went.
		 */
		signInLink(event, params, show) {
			const handle = Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => byte.toString(16).padStart(2, "0")).join("");
			event.currentTarget.href = `./api/oauth/start?${new URLSearchParams({ ...params, handle })}`;
			this.watchSignIn(handle, show);
		},
		async watchSignIn(handle, show) {
			show({ state: "waiting", text: "Finish signing in in the new tab. This updates when you're done." });
			for (let tries = 0; tries < 300; tries++) {
				await new Promise((done) => setTimeout(done, 2000));
				const result = await this.getJson(`./api/oauth/result/${handle}`, null);
				if (result && result.state !== "waiting") return show(result);
			}
			show({ state: "failed", text: "The sign-in took too long. Start it again." });
		},
		signInGoogle(event, hint) {
			this.signInLink(event, { for: "google", ...(hint ? { hint } : {}) }, async (result) => {
				this.connectorResult = { ok: result.state !== "failed", text: result.text };
				if (result.state === "done") {
					await this.loadConnectors();
					await this.loadLedger();
					this.connectorResult = { ok: true, text: result.text };
				}
			});
		},
		signInMcp(event, server) {
			this.signInLink(event, { for: "mcp", id: server.id }, async (result) => {
				const shown = this.mcpServers.find((entry) => entry.id === server.id) || server;
				shown.probe = result.text;
				if (result.state === "done") {
					const fresh = (await this.getJson("./api/mcp", [])).find((entry) => entry.id === server.id);
					if (fresh) Object.assign(shown, fresh, { probe: result.text });
				}
			});
		},
		connectorLine(connector) {
			const service = this.presetOf(connector.preset)?.label || connector.preset;
			const status = connector.status
				? connector.status.ok
					? `Last check ${this.formatWhen(connector.status.at)}, worked.`
					: `Last check ${this.formatWhen(connector.status.at)} failed: ${connector.status.error}`
				: connector.enabled
					? "Not checked yet."
					: "Off.";
			const google = connector.values.auth === "google";
			const how = google ? `, signed in with Google${/contacts/.test(connector.values.scope || "") ? ", contacts too" : ""}` : "";
			return `${connector.values.address}, ${service}${how}. ${status}`;
		},
		async addConnector() {
			this.connectorBusy = true;
			this.connectorResult = null;
			const form = this.newConnector;
			try {
				const data = await this.request("./api/connectors", "POST", {
					kind: "mail",
					preset: form.preset,
					name: form.name.trim(),
					values: { address: form.address.trim(), host: form.host.trim(), port: form.port, smtpHost: form.smtpHost.trim(), smtpPort: form.smtpPort },
					secrets: { password: form.password },
				});
				this.connectorResult = { ok: true, text: `${data.connector.name} added. ${data.result}` };
				this.newConnector = { preset: form.preset, how: form.how, name: "", address: "", password: "", host: "", port: "993", smtpHost: "", smtpPort: "587" };
				await this.loadConnectors();
				await this.loadLedger();
			} catch (error) {
				this.connectorResult = { ok: false, text: error.message };
			} finally {
				this.connectorBusy = false;
			}
		},
		async updateConnector(connector, change) {
			const what = connector.kind === "parcel" ? "key" : "password";
			connector.probe = change.secrets ? `Testing the new ${what}` : "";
			try {
				await this.request(`./api/connectors/${encodeURIComponent(connector.id)}`, "PATCH", change);
				await this.loadConnectors();
				if (change.secrets) this.connectors.find((entry) => entry.id === connector.id).probe = `${what === "key" ? "Key" : "Password"} changed.`;
			} catch (error) {
				connector.probe = `Not saved: ${error.message}`;
			}
		},
		async testConnector(connector) {
			connector.probe = "Testing";
			const data = await this.request(`./api/connectors/${encodeURIComponent(connector.id)}/test`).catch((error) => ({ ok: false, error: error.message }));
			connector.probe = data.ok ? data.message : `Failed: ${data.error}`;
		},
		async removeConnector(connector) {
			const question = { feed: `Remove the feed ${connector.name}?`, parcel: `Remove ${connector.name}? Parcels tracked through it stop being checked.` }[connector.kind] || `Remove ${connector.name}? RemindMe stops reading it; nothing in the mailbox changes.`;
			if (!window.confirm(question)) return;
			await fetch(`./api/connectors/${encodeURIComponent(connector.id)}`, { method: "DELETE" });
			await this.loadConnectors();
		},

		/* Scheduled tasks */
		async addTask() {
			if (!this.newTaskWhat.trim() || !this.newTaskWhen.trim()) {
				this.taskError = "Say what to do and when, such as daily at 8.";
				return;
			}
			try {
				this.tasks.unshift(await this.request("./api/tasks", "POST", { prompt: this.newTaskWhat.trim(), text: this.newTaskWhen.trim(), deliver: ["notify"] }));
				this.newTaskWhat = "";
				this.newTaskWhen = "";
				this.taskError = "";
				await this.loadLedger();
			} catch (error) {
				this.taskError = error.message;
			}
		},
		async runTask(task) {
			this.taskError = `Running ${task.name}. The result arrives on Discord.`;
			await this.request(`./api/tasks/${encodeURIComponent(task.id)}/run`).catch((error) => (this.taskError = error.message));
			this.tasks = await this.getJson("./api/tasks", this.tasks);
		},
		async deleteTask(task) {
			if (!window.confirm(`Delete "${task.name}"?`)) return;
			await fetch(`./api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
			this.tasks = this.tasks.filter((entry) => entry.id !== task.id);
			await this.loadLedger();
		},
	};
}
