/*
 * The RemindMe console: a command line on top, what is waiting on you, and
 * one ledger of everything RemindMe said, did and will do, newest first with
 * "now" in the middle. The ledger comes from /api/ledger; a turn streams in
 * from /api/chat and then lands in the ledger like any other answer.
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
};

const TOOL_WORDS = {
	house_overview: "checking the house",
	find_devices: "finding devices",
	control_devices: "changing devices",
	calendar_events: "reading the calendars",
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
};

function pad(value) {
	return String(value).padStart(2, "0");
}

function dayKey(date) {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function remindme() {
	return {
		/* The ledger */
		ai: null,
		waiting: [],
		batteries: [],
		upcoming: [],
		entries: [],
		now: new Date(),
		filter: "all",
		tabs: [
			{ id: "all", label: "Everything" },
			{ id: "coming", label: "Coming up" },
			{ id: "did", label: "What it did" },
			{ id: "messages", label: "Messages" },
		],
		/* The command line */
		draft: "",
		pictures: [],
		busy: false,
		working: null,
		error: "",
		abort: null,
		/* Settings */
		settingsOpen: false,
		settingsTab: "ai",
		sections: [
			{ id: "ai", label: "AI and sign-ins" },
			{ id: "prompt", label: "How it talks" },
			{ id: "skills", label: "Skills" },
			{ id: "mcp", label: "Connected tools" },
			{ id: "tasks", label: "Scheduled tasks" },
			{ id: "documents", label: "Documents" },
		],
		aiModels: [],
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
		tasks: [],
		newTaskWhat: "",
		newTaskWhen: "",
		taskError: "",
		documents: [],
		/* The CLI agents' sign-in console (account-console.js) */
		authConsole: { id: "", backend: "", running: false, output: "", urls: [] },
		authConsoleOpen: false,
		authConsoleBackend: "codex",
		authConsoleProvider: "",
		authConsoleInput: "",
		authConsoleError: "",
		authConsoleBusy: false,
		agentPiProviders: [],

		init() {
			this.loadLedger();
			setInterval(() => {
				this.now = new Date();
				if (!this.busy && !document.hidden) this.loadLedger();
			}, 30_000);
			document.addEventListener("visibilitychange", () => {
				if (!document.hidden) this.loadLedger();
			});
			this.$nextTick(() => this.$refs.ask?.focus());
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

		async loadLedger() {
			try {
				const response = await fetch("./api/ledger", { cache: "no-store" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const data = await response.json();
				this.ai = { ...(this.ai || {}), ...data.ai };
				this.waiting = data.waiting || [];
				this.batteries = data.batteries || [];
				this.upcoming = data.upcoming || [];
				this.entries = data.entries || [];
				this.now = new Date(data.now || Date.now());
				this.error = "";
			} catch (error) {
				this.error = `RemindMe isn't answering (${error.message || error}). It may be restarting.`;
			}
		},

		/* ── The ledger, as rows ─────────────────────────────────────── */

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
				return {
					type: "row",
					key: `up-${index}-${item.at}`,
					at,
					time: item.allDay ? "all day" : this.timeOf(at),
					kind: item.kind,
					text: `${item.text}${until}`,
					css: "future",
					reminderId: item.reminderId,
				};
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
			if (this.working && this.filter !== "coming" && this.filter !== "did")
				past = [{ type: "row", key: "working", at: this.now, time: this.clock, kind: this.working.status, question: this.working.question, text: this.working.text || "", css: "working" }, ...past];
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

		renderText(element, text) {
			element.replaceChildren();
			if (!text) return;
			if (window.RemindMeRichText) window.RemindMeRichText.render(element, text);
			else element.textContent = text;
		},

		/* ── The command line ────────────────────────────────────────── */

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

		stop() {
			this.abort?.abort();
		},

		async send() {
			const text = this.draft.trim() || (this.pictures.length ? "What's in this picture?" : "");
			if (!text || this.busy) return;
			this.draft = "";
			this.error = "";
			this.busy = true;
			if (this.filter === "coming" || this.filter === "did") this.filter = "all";
			this.working = { question: text, status: "thinking", text: "" };
			this.abort = new AbortController();
			const attachments = this.pictures;
			this.pictures = [];
			try {
				const response = await fetch("./api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ message: text, attachments }),
					signal: this.abort.signal,
				});
				if (!response.ok || !response.body) throw new Error("RemindMe didn't start answering.");
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
						if (event === "tool_start") this.working.status = TOOL_WORDS[String(data.name || "").split(" ")[0]] || "working";
						else if (event === "answer_delta") {
							this.working.status = "answering";
							this.working.text += data.text || "";
						} else if (event === "error") throw new Error(data.message);
					}
				}
			} catch (error) {
				if (error.name !== "AbortError") this.error = error.message || String(error);
			} finally {
				this.busy = false;
				this.working = null;
				this.abort = null;
				await this.loadLedger();
				this.$nextTick(() => this.$refs.ask?.focus());
			}
		},

		async newTopic() {
			await fetch("./api/chat/reset", { method: "POST" });
			this.error = "";
			this.$refs.ask?.focus();
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
			await this.loadLedger();
		},

		async cancelWait(item) {
			await this.request("./api/confirm/cancel", "POST", { token: item.token }).catch(() => {});
			await this.loadLedger();
		},

		async remindBattery(item) {
			const at = new Date(this.now);
			at.setDate(at.getDate() + ((6 - at.getDay() + 7) % 7 || 7));
			at.setHours(10, 0, 0, 0);
			try {
				await this.request("./api/reminders", "POST", { message: `Put a new battery in the ${item.name}`, at: at.toISOString() });
			} catch (error) {
				this.error = error.message;
			}
			await this.loadLedger();
		},

		async cancelReminder(row) {
			await fetch(`./api/reminders/${encodeURIComponent(row.reminderId)}`, { method: "DELETE" });
			await this.loadLedger();
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
			const option = this.ai?.providers?.find((entry) => entry.id === this.ai.provider);
			if (!option?.configured) return;
			const response = await fetch(`./api/ai/models?provider=${encodeURIComponent(option.id)}`);
			const data = await response.json().catch(() => ({}));
			if (response.ok) this.aiModels = data.models || [];
			else this.aiError = data.error || "Could not list the models.";
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
			return "Web search: off. Add a SearXNG address or an Exa key in the app options to search with OpenCode or the agents.";
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
				server.probe = data.ok ? `Connected to ${data.serverName || server.name}: ${data.tools.map((tool) => tool.name).join(", ") || "no tools"}` : `Failed: ${data.error}`;
			} catch (error) {
				server.probe = `Failed: ${error.message}`;
			}
		},
		async deleteMcp(server) {
			if (!window.confirm(`Remove "${server.name}"?`)) return;
			await fetch(`./api/mcp/${encodeURIComponent(server.id)}`, { method: "DELETE" });
			this.mcpServers = this.mcpServers.filter((entry) => entry.id !== server.id);
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
