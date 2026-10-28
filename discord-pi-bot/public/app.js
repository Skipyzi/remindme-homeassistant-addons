/*
 * The RemindMe console: an inbox. What needs you comes first, then the jobs
 * and scheduled tasks running, then every conversation and everything
 * RemindMe sent or did, newest first. Each request is a thread of its own;
 * a job lives in the thread that started it. The old timeline is History.
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

const CHANNEL_NOTES = {
	discord: "On Discord",
	brief: "Morning brief, on Discord",
	nudge: "On Discord",
	reminder: "Reminder, on Discord and your phone",
	task: "Scheduled task",
	job: "From a job",
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
/* The first word of a held action, when it is a plain verb, names its button. */
const VERBS = new Set(["Unlock", "Lock", "Open", "Close", "Add", "Run", "Arm", "Disarm", "Send"]);

function pad(value) {
	return String(value).padStart(2, "0");
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
		/* The inbox */
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
		sections: [
			{ id: "ai", label: "AI and sign-ins" },
			{ id: "connectors", label: "Connectors" },
			{ id: "phone", label: "Phone app" },
			{ id: "prompt", label: "How it talks" },
			{ id: "memory", label: "Memory" },
			{ id: "skills", label: "Skills" },
			{ id: "mcp", label: "Connected tools" },
			{ id: "tasks", label: "Scheduled tasks" },
			{ id: "documents", label: "Documents" },
		],
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

		init() {
			const fit = () => document.documentElement.style.setProperty("--app-height", `${window.innerHeight}px`);
			fit();
			window.addEventListener("resize", fit);
			this.loadInbox();
			this.route();
			window.addEventListener("popstate", () => this.route());
			// A tapped notification opens its thread by changing the address.
			window.addEventListener("hashchange", () => this.route());
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
				this.waiting = data.waiting || [];
				// A battery just dealt with keeps its card a moment longer, to show what happened.
				const settled = this.batteries.filter((item) => item.done);
				this.batteries = [...(data.batteries || []).filter((item) => !settled.some((done) => done.entityId === item.entityId)), ...settled];
				this.threads = data.threads || [];
				this.scheduled = data.tasks || [];
				this.activity = data.activity || [];
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

		get working() {
			return this.threads.filter((thread) => thread.job && ["queued", "working", "waiting"].includes(thread.job.status));
		},

		get needsCount() {
			return this.waiting.length + this.asking.length + this.batteries.length;
		},

		get inboxLine() {
			const day = this.now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
			const needs = this.needsCount;
			return `${day} · ${needs ? `${needs} need${needs === 1 ? "s" : ""} you` : "nothing needs you"}`;
		},

		threadItem(thread) {
			const job = thread.job;
			const item = { key: `t-${thread.id}`, threadId: thread.id, openId: thread.id, at: new Date(thread.updatedAt), title: thread.title, line: firstLine(thread.last), mark: "›", bad: false, cat: this.catState(thread) };
			if (job?.status === "done") item.mark = "✓";
			if (job?.status === "stopped") Object.assign(item, { mark: "✕", bad: Boolean(job.error), line: job.error || job.note || item.line });
			return item;
		},

		activityItem(entry) {
			const base = { key: `a-${entry.id}`, openId: `entry:${entry.id}`, at: new Date(entry.at), entry, mark: "↗", bad: false };
			const line = firstLine(entry.text);
			if (entry.kind === "failed") return { ...base, mark: "✕", bad: true, title: "Couldn't do this", line };
			if (entry.channel === "brief") return { ...base, mark: "☀", title: "Morning brief", line };
			if (entry.channel === "reminder") return { ...base, title: "Reminded you", line };
			if (entry.kind === "did") {
				const receipts = entry.receipts || [];
				return { ...base, mark: "•", color: receipts.find((receipt) => receipt.color)?.color, title: receipts[0]?.text || line, line: receipts.length > 1 ? `and ${receipts.length - 1} more` : CHANNEL_NOTES[entry.channel] || "" };
			}
			if (entry.kind === "answered") return { ...base, mark: "›", title: entry.question || "Answered", line: `${CHANNEL_NOTES[entry.channel] || ""}: ${line}`.replace(/^: /, "") };
			if (entry.kind === "confirmed") return { ...base, mark: "✓", title: entry.text, line: "Done after your tap" };
			if (entry.kind === "cancelled") return { ...base, mark: "–", title: entry.text, line: "Cancelled" };
			return { ...base, title: entry.channel === "task" ? "Scheduled task" : "Sent you", line };
		},

		get groups() {
			const busy = new Set([...this.asking, ...this.working].map((thread) => thread.id));
			const items = [...this.threads.filter((thread) => !busy.has(thread.id)).map((thread) => this.threadItem(thread)), ...this.activity.map((entry) => this.activityItem(entry))].sort((a, b) => b.at - a.at);
			const today = dayKey(this.now);
			const yesterday = dayKey(new Date(this.now.getTime() - 86_400_000));
			const groups = [
				{ id: "today", label: "Today", items: [] },
				{ id: "yesterday", label: "Yesterday", items: [] },
				{ id: "earlier", label: "Earlier", items: [] },
			];
			for (const item of items) {
				const key = dayKey(item.at);
				const group = key === today ? groups[0] : key === yesterday ? groups[1] : groups[2];
				item.time = group === groups[2] ? item.at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : this.timeOf(item.at);
				group.items.push(item);
			}
			groups[2].items = groups[2].items.slice(0, 40);
			return groups.filter((group) => group.items.length);
		},

		get isEmpty() {
			return !this.needsCount && !this.working.length && !this.scheduled.length && !this.groups.length;
		},

		jobLine(thread) {
			const job = thread.job;
			if (!job) return thread.last;
			const progress = job.progress ? `${job.progress.done} of ${job.progress.total}` : "";
			return [JOB_WORDS[job.status], progress, job.note].filter(Boolean).join(" · ");
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
			window.RemindMeCats?.render(element, seed, state);
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

		/* ── A thread ────────────────────────────────────────────────── */

		route() {
			const match = location.hash.match(/^#t\/([\w-]+)$/);
			if (match) this.showThread(match[1]);
			else this.open = null;
		},

		openThread(id) {
			if (this.open?.id === id) return;
			history.pushState({ thread: id }, "", `#t/${id}`);
			this.showThread(id);
		},

		async showThread(id) {
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

		/* Something RemindMe sent or did outside a thread, shown on its own. */
		openEntry(item) {
			const entry = item.entry;
			const meta = `${this.formatWhen(entry.at)} · ${CHANNEL_NOTES[entry.channel] || "RemindMe"}`;
			if (history.state?.thread) history.replaceState(null, "", location.pathname + location.search);
			this.open = {
				id: item.openId,
				readOnly: true,
				title: item.title,
				createdAt: entry.at,
				meta,
				messages: [
					...(entry.question ? [{ id: "q", role: "user", at: entry.at, text: entry.question }] : []),
					{ id: "a", role: "assistant", at: entry.at, meta, text: entry.receipts?.length ? "" : entry.text, receipts: entry.receipts },
				],
			};
		},

		closeThread() {
			if (history.state?.thread) history.back();
			else {
				if (location.hash) history.replaceState(null, "", location.pathname + location.search);
				this.open = null;
			}
		},

		async refreshThread() {
			const open = this.open;
			if (!open || open.readOnly) return;
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
			const job = thread.job;
			if (!job) return `Started ${this.formatWhen(thread.createdAt)}`;
			const progress = job.progress ? ` · ${job.progress.done} of ${job.progress.total}` : "";
			return `Job · ${JOB_WORDS[job.status] || job.status}${progress} · started ${this.formatWhen(thread.createdAt)}`;
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

		/* A new request from the inbox: it opens a thread of its own. */
		async send() {
			const text = this.draft.trim();
			if ((!text && !this.pictures.length) || this.sending) return;
			const attachments = this.pictures;
			this.draft = "";
			this.pictures = [];
			await this.stream("./api/threads", { message: text, attachments }, true);
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
				if (fresh) this.$nextTick(() => this.$refs.ask?.focus());
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

		async openHistory() {
			this.historyOpen = true;
			await this.loadHistory();
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
				return { type: "row", key: `up-${index}-${item.at}`, at, time: item.allDay ? "all day" : this.timeOf(at), kind: item.kind, text: `${item.text}${until}`, css: "future", reminderId: item.reminderId };
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

		async openSettings(tab) {
			this.settingsTab = tab;
			this.settingsOpen = true;
			if (tab === "ai") await this.loadAi();
			if (tab === "prompt") await this.loadPersona();
			if (tab === "skills") this.skills = await this.getJson("./api/skills", []);
			if (tab === "mcp") this.mcpServers = await this.getJson("./api/mcp", []);
			if (tab === "tasks") this.tasks = await this.getJson("./api/tasks", []);
			if (tab === "connectors") await this.loadConnectors();
			if (tab === "phone") await this.loadPhone();
			if (tab === "memory") this.memory = await this.getJson("./api/memory", { learn: true, facts: [] });
			if (tab === "documents") this.documents = (await this.getJson("./api/artifacts", [])).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
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

		/* How it talks */
		async loadPersona() {
			const data = await this.getJson("./api/persona", {});
			this.persona = data.prompt || "";
			this.personaStatus = "";
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
			this.phone = await this.getJson("./api/phone", { state: "error", error: "RemindMe didn't answer." });
			if (this.pushPossible) {
				const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined);
				this.pushOn = Boolean(await registration?.pushManager.getSubscription().catch(() => null));
			}
			this.pollPhone();
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
			connector.probe = change.secrets ? "Testing the new password" : "";
			try {
				await this.request(`./api/connectors/${encodeURIComponent(connector.id)}`, "PATCH", change);
				await this.loadConnectors();
				if (change.secrets) this.connectors.find((entry) => entry.id === connector.id).probe = "Password changed.";
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
			if (!window.confirm(`Remove ${connector.name}? RemindMe stops reading it; nothing in the mailbox changes.`)) return;
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
