function harness() {
	return {
		messages: [],
		conversations: [],
		currentConversationId: "",
		conversationSearch: "",
		draft: "",
		attachments: [],
		attachmentError: "",
		visionEnabled: false,
		thinkingProfiles: [
			{
				id: "fast",
				name: "Fast",
				reasoningBudget: 0,
				answerReserve: 512,
				description: "No visible reasoning.",
				estimatedMaxSeconds: 0,
				recommended: false,
			},
			{
				id: "balanced",
				name: "Balanced",
				reasoningBudget: 384,
				answerReserve: 768,
				description: "Short bounded reasoning.",
				estimatedMaxSeconds: 55,
				recommended: true,
			},
			{
				id: "deep",
				name: "Deep",
				reasoningBudget: 1024,
				answerReserve: 1024,
				description: "Longer reasoning for difficult questions.",
				estimatedMaxSeconds: 147,
				recommended: false,
			},
		],
		thinking: localStorage.getItem("remindme.profile") || "fast",
		profile: localStorage.getItem("remindme.profile") || "fast",
		busy: false,
		/* In-chat activity row: shows the turn is alive during the dead air
		 * before the first phase event, which on a Pi can be many seconds. */
		activity: null,
		activityElapsed: 0,
		settingsOpen: false,
		skillsOpen: false,
		skills: [],
		newSkillName: "",
		newSkillBody: "",
		skillError: "",
		modelDiagnostics: null,
		mcpOpen: false,
		mcpServers: [],
		newMcpName: "",
		newMcpUrl: "",
		newMcpAuth: "",
		mcpError: "",
		modelsOpen: false,
		historyOpen: false,
		boardOpen: false,
		offline: false,
		scanlines: true,
		glow: 55,
		...window.RemindMeModelCookbook.state(),
		modelBadge: "LOCAL • QWEN",
		sessionLabel: "ready // private network",
		hardware: "raspberry pi profile",
		metrics: {},
		system: null,
		artifactOpen: false,
		currentArtifact: null,
		/** "preview" renders the document; "source" shows what it is made of. */
		artifactView: "preview",
		/** True while the model is still writing the document on the bench. */
		artifactStreaming: false,
		/** The source view is an editor; this is what is in it. */
		artifactSource: "",
		artifactSaving: false,
		/** What the frame last reported: a compile error, or nothing. */
		artifactStatus: "",
		/** Inference endpoints: the switchable list of where the model runs. */
		endpoints: [],
		endpointActiveId: "",
		endpointDraft: null,
		endpointError: "",
		endpointTest: null,
		endpointBusy: false,
		tokenUsage: {
			exact: false,
			promptTokens: 0,
			contextTokens: 0,
			contextCapacity: 8192,
		},
		get currentThinkingProfile() {
			return (
				this.thinkingProfiles.find((preset) => preset.id === this.thinking) ||
				this.thinkingProfiles[0]
			);
		},
		get filteredConversations() {
			const query = this.conversationSearch.trim().toLowerCase();
			return this.conversations.filter(
				(conversation) =>
					!query || conversation.title.toLowerCase().includes(query),
			);
		},
		get contextPercent() {
			return this.tokenUsage.exact
				? Math.min(
						100,
						((this.tokenUsage.contextTokens + this.tokenUsage.promptTokens) /
							this.tokenUsage.contextCapacity) *
							100,
					)
				: 0;
		},
		get modelOperationBusy() {
			return [
				"preflight",
				"downloading",
				"verifying",
				"activating",
				"probing",
				"rollback",
			].includes(this.modelOperation?.phase);
		},
		get contextLevel() {
			return this.contextPercent >= 90
				? "danger"
				: this.contextPercent >= 70
					? "warning"
					: "healthy";
		},
		init() {
			this.restore();
			this.scanlines = localStorage.getItem("remindme.scanlines") !== "0";
			this.glow = Number(localStorage.getItem("remindme.glow") || 55);
			document.documentElement.style.setProperty("--glow", this.glow / 100);
			this.$watch("thinking", (value) => {
				this.profile = value;
				localStorage.setItem("remindme.profile", value);
			});
			this.$watch("glow", (value) =>
				localStorage.setItem("remindme.glow", String(value)),
			);
			this.$watch("scanlines", (value) =>
				localStorage.setItem("remindme.scanlines", value ? "1" : "0"),
			);
			this.$watch("draft", () => window.RemindMeComposer.measure(this));
			window.RemindMeComposer.measure(this, 0);
			window.RemindMeConversations.load(this).catch(() => {});
			this.refreshStatus();
			window.RemindMeModelCookbook.load(this);
			window.RemindMeEndpoints.load(this);
			this.startSystemPolling();
			/*
			 * The artifact frame reports what happened when it ran. It holds
			 * an opaque origin, so `event.origin` is the string "null" and
			 * proves nothing — the frame's own window is the identity that
			 * can be checked.
			 */
			window.addEventListener("message", (event) => {
				const frame = document.querySelector(".artifact-frame");
				if (!frame || event.source !== frame.contentWindow) return;
				if (typeof event.data?.artifactStatus === "string")
					this.artifactStatus = event.data.artifactStatus;
			});
			/*
			 * The reader glyph beside a link asks, through a bubbling DOM event,
			 * for the page to be fetched and shown in the artifact panel. The
			 * link itself still opens the live site in a new tab untouched.
			 */
			window.addEventListener("remindme:reader", (event) => {
				const url = event.detail?.url;
				if (url) this.openReader(url);
			});
		},
		/**
		 * Pull the model badge, capabilities and thinking profiles from the
		 * server. Re-runnable, so switching endpoints refreshes the badge
		 * without a reload — a custom endpoint reports its own name and model.
		 */
		refreshStatus() {
			return fetch("./api/status")
				.then((r) => r.json())
				.then((d) => {
					const custom = this.endpointActiveId;
					this.modelBadge =
						(custom ? "" : "LOCAL • ") + (d.modelName || d.model);
					this.visionEnabled = Boolean(d.vision);
					if (Array.isArray(d.profiles) && d.profiles.length) {
						this.thinkingProfiles = d.profiles;
						if (!d.profiles.some((preset) => preset.id === this.thinking)) {
							this.thinking =
								d.profiles.find((preset) => preset.recommended)?.id || "fast";
							this.profile = this.thinking;
						}
					}
					if (d.hardware)
						this.hardware = `${d.hardware.architecture} / ${d.hardware.cpuCores} cores`;
					this.offline = false;
				})
				.catch(() => {
					this.offline = true;
				});
		},
		/* ── Inference endpoints ──────────────────────────────────────── */
		editEndpoint(endpoint) {
			window.RemindMeEndpoints.edit(this, endpoint);
		},
		newEndpoint() {
			window.RemindMeEndpoints.edit(this, null);
		},
		cancelEndpoint() {
			window.RemindMeEndpoints.cancel(this);
		},
		saveEndpoint() {
			return window.RemindMeEndpoints.save(this);
		},
		deleteEndpoint(endpoint) {
			return window.RemindMeEndpoints.remove(this, endpoint);
		},
		activateEndpoint(id) {
			return window.RemindMeEndpoints.activate(this, id);
		},
		testEndpoint() {
			return window.RemindMeEndpoints.test(this);
		},
		persist() {
			localStorage.setItem(
				"remindme.history",
				JSON.stringify(
					this.messages.map((message) => ({
					...message,
					confirm: undefined,
					// A half-filled wizard is live UI state, not transcript. Drop
					// it so a restored conversation never reopens a stale form.
					wizard: undefined,
				})),
				),
			);
			window.RemindMeConversations.save(this);
		},
		restore() {
			try {
				const saved = JSON.parse(
					localStorage.getItem("remindme.history") || "[]",
				);
				if (!Array.isArray(saved)) return;
				/*
				 * Transcripts saved before `kind` was the only word for what a
				 * row is still carry a `type`. Carry them over rather than
				 * leaving the last conversation to come back unstyled.
				 */
				this.messages = saved.map(({ type, ...message }) => ({
					...message,
					kind: message.kind || (type === "assistant" ? "answer" : type),
				}));
			} catch (_) {}
		},
		/**
		 * The transcript in the shape the model reads it: the turns someone
		 * actually said, oldest first. Tool rows and cards are furniture —
		 * their contents already reached the model as tool results, and
		 * replaying them as prose would only invite the model to imitate
		 * the format instead of using the tools.
		 *
		 * The token meter measures this same list, so what the gauge counts
		 * and what the request carries cannot drift apart.
		 */
		modelHistory() {
			const turns = [];
			// A web search's hits are dropped from history like every other
			// tool row — the fat snippets are a within-turn cost, the +N the
			// badge shows, and carrying them forward would fill the window in
			// a search or two. But the titles and URLs are kept, trimmed to
			// that, and folded into the answer that used them, so a later
			// "link the sources" has something real to link instead of the
			// model inventing homepages.
			let sources = "";
			for (const message of this.messages) {
				if (message.kind === "tool" && message.name === "web_search") {
					const results = message.result?.results;
					if (Array.isArray(results) && results.length) {
						const list = results
							.slice(0, 6)
							.filter((result) => result?.url)
							.map(
								(result, index) =>
									`${index + 1}. ${result.title || result.url} — ${result.url}`,
							)
							.join("\n");
						if (list) sources = `\n\n[Web search sources:\n${list}]`;
					}
					continue;
				}
				if (message.kind === "user" && message.text?.trim()) {
					turns.push({ role: "user", content: message.text });
				} else if (message.kind === "answer" && message.text?.trim()) {
					turns.push({ role: "assistant", content: message.text + sources });
					sources = "";
				}
			}
			return turns;
		},
		/**
		 * Add a row to the transcript.
		 *
		 * `kind` is the only word for what a row is: user, answer, thinking
		 * or tool. There used to be a second one — `type` — set here while
		 * the streaming timeline set `kind`, and every place that had to ask
		 * what a row was had to know both. Rows were styled by whichever
		 * they had, which dressed restored tool calls as replies, and the
		 * transcript sent to the model read only `type`, which meant it was
		 * sent the questions and none of the answers.
		 */
		add(kind, text, extra = {}) {
			const message = {
				id: `${Date.now()}-${Math.random()}`,
				kind,
				text,
				...extra,
			};
			this.messages.push(message);
			this.persist();
			this.scrollToBottom();
			return message;
		},
		async newChat() {
			await window.RemindMeConversations.create(this);
			this.add("answer", "Fresh channel. What are we checking?");
		},
		selectConversation(conversation) {
			return window.RemindMeConversations.select(this, conversation);
		},
		/** Pin to the top. The store already sorts pinned first. */
		async togglePin(conversation) {
			const pinned = !conversation.pinned;
			conversation.pinned = pinned;
			const saved = await window.RemindMeConversations.patch(conversation.id, {
				pinned,
			});
			if (!saved) {
				conversation.pinned = !pinned;
				return;
			}
			Object.assign(conversation, saved);
			// Re-sort locally so the row moves without waiting for a reload.
			this.conversations = [...this.conversations].sort(
				(a, b) =>
					Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
					String(b.updatedAt).localeCompare(String(a.updatedAt)),
			);
		},
		/** Relative age, so the list reads without doing date arithmetic. */
		conversationWhen(conversation) {
			const then = new Date(conversation.updatedAt).getTime();
			if (!Number.isFinite(then)) return "";
			const minutes = Math.floor((Date.now() - then) / 60000);
			if (minutes < 1) return "just now";
			if (minutes < 60) return `${minutes}m ago`;
			const hours = Math.floor(minutes / 60);
			if (hours < 24) return `${hours}h ago`;
			const days = Math.floor(hours / 24);
			return days < 7
				? `${days}d ago`
				: new Date(conversation.updatedAt).toLocaleDateString();
		},
		conversationSize(conversation) {
			const count = (conversation.messages || []).length;
			return count ? `${count} msg` : "empty";
		},
		/**
		 * The opening line — the fastest way to recognise a conversation.
		 *
		 * Dropped when it only restates the title. An auto-named conversation
		 * takes its title from this same first message, so showing both spends
		 * a third of the card on a duplicate; the preview earns its line only
		 * once the title has diverged, which is when it is worth reading.
		 */
		conversationPreview(conversation) {
			const first = (conversation.messages || []).find(
				(message) => message.role === "user" && message.text?.trim(),
			);
			if (!first) return "";
			const text = first.text.replace(/\s+/g, " ").trim();
			const stem = (value) =>
				value.toLowerCase().replace(/[…\s.,;:!?-]+$/, "");
			const title = stem(String(conversation.title || ""));
			if (title && stem(text).startsWith(title)) return "";
			return text.length > 64 ? `${text.slice(0, 64)}…` : text;
		},
		clearChat() {
			this.messages = [];
			this.persist();
		},
		formatTime(value) {
			return value ? new Date(value).toLocaleString() : "";
		},
		json(value) {
			return JSON.stringify(value, null, 2);
		},
		recentTrace(message) {
			return window.RemindMeTimeline.recentTraceLines(message.text, 3);
		},
		thoughtLabel(message) {
			return window.RemindMeThinking.formatThought(message);
		},
		toolLabel(message) {
			return window.RemindMeTools.toolActivity(message.name);
		},
		completedToolLabel(message) {
			const duration = this.formatDuration(message.metrics?.totalMs);
			return `${String(message.name || "Tool").replaceAll("_", " ")} · ${duration}`;
		},
		formatSpeed(value) {
			return `${Number(value || 0).toFixed(1)} tok/s`;
		},
		formatDuration(value) {
			const milliseconds = Number(value || 0);
			return milliseconds >= 60_000
				? `${(milliseconds / 60_000).toFixed(1)} min`
				: `${(milliseconds / 1_000).toFixed(1)} s`;
		},
		/**
		 * Render message text as rich text: markdown structure, then maths.
		 * Falls back to the maths-only renderer, then to plain text, so a
		 * missing component degrades rather than blanking the reply.
		 */
		renderMessageText(element, text) {
			if (window.RemindMeRichText)
				window.RemindMeRichText.render(element, text);
			else if (window.RemindMeMath) window.RemindMeMath.render(element, text);
			else element.textContent = String(text || "");
		},
		async openArtifact(id) {
			try {
				const response = await fetch(`./api/artifacts/${encodeURIComponent(id)}`);
				if (!response.ok) return;
				this.currentArtifact = await response.json();
				this.artifactSource = this.currentArtifact.content || "";
				this.artifactStreaming = false;
				this.artifactView = "preview";
				this.artifactOpen = true;
			} catch {
				/* nothing to show */
			}
		},
		/** The bare host of a URL, for a title before the real one arrives. */
		readerHost(url) {
			try {
				return new URL(url).host;
			} catch {
				return String(url || "");
			}
		},
		/**
		 * Reader mode. Fetch a link's readable text server-side and show it in
		 * the artifact panel as a document with no id — so it rides the same
		 * pane and renderer as an artifact but carries no SAVE or DELETE, and
		 * is never framed. The live site is left to the link's own new tab.
		 */
		async openReader(url) {
			const href = String(url || "");
			if (!/^https?:\/\//i.test(href)) return;
			const show = (content, title) => {
				this.currentArtifact = {
					kind: "reader",
					title: title || this.readerHost(href),
					content,
					sourceUrl: href,
				};
			};
			show(`Fetching ${href} …`);
			this.artifactSource = "";
			this.artifactStreaming = false;
			this.artifactView = "preview";
			this.artifactOpen = true;
			try {
				const response = await fetch(`./api/reader?url=${encodeURIComponent(href)}`);
				const data = await response.json().catch(() => ({}));
				if (!response.ok || !data?.text) {
					const reason = data?.error || `Could not read the page (HTTP ${response.status}).`;
					show(`${reason}\n\n[Open the original ↗](${href})`);
					return;
				}
				const head = [
					`# ${data.title || this.readerHost(href)}`,
					`[Open the original ↗](${href})`,
				];
				if (data.byline) head.push(`_${data.byline}_`);
				if (data.truncated) head.push("_(truncated for length)_");
				show(`${head.join("\n\n")}\n\n${data.text}`, data.title);
			} catch {
				show(`Could not reach the reader.\n\n[Open the original ↗](${href})`);
			}
		},
		/**
		 * The model has started writing a document. Put an empty one on the
		 * bench so the text has somewhere to land.
		 *
		 * This is a draft with no id: nothing is saved until the tool call
		 * completes, and if the model abandons it mid-write the draft simply
		 * never settles.
		 */
		beginArtifactDraft(data) {
			this.currentArtifact = {
				id: null,
				title: data.title || "Writing…",
				kind: data.kind || "code",
				content: "",
			};
			this.artifactStreaming = true;
			// Source while it writes: a half-built page renders as nonsense,
			// and watching the markup arrive is the part worth seeing.
			this.artifactView = "source";
			this.artifactOpen = true;
		},
		appendArtifactDraft(data) {
			if (!this.currentArtifact || !this.artifactStreaming) return;
			this.currentArtifact.content += data.text || "";
		},
		/**
		 * The write finished, or an edit landed. Replace whatever is on the
		 * bench with the saved document and show it rendered.
		 */
		async settleArtifact(artifact) {
			if (!artifact?.id) return;
			this.artifactStreaming = false;
			await this.openArtifact(artifact.id);
		},
		/* ── Source editor ────────────────────────────────────────────── */
		editorPaint(element) {
			window.RemindMeEditor.paint(
				element,
				this.artifactSource,
				window.RemindMeEditor.languageFor(this.currentArtifact),
			);
		},
		editorGutter() {
			return window.RemindMeEditor.gutterText(this.artifactSource);
		},
		editorKey(event) {
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				this.applyArtifactEdit();
				return;
			}
			if (window.RemindMeEditor.handleKey(event, event.target))
				// setRangeText bypasses the input event x-model listens for.
				this.artifactSource = event.target.value;
		},
		editorScroll(event) {
			window.RemindMeEditor.syncScroll(event.target);
		},
		/** Line and column, so an error's line number can be found. */
		editorPosition() {
			const field = document.querySelector("textarea.editor-text");
			if (!field) return "";
			const upto = field.value.slice(0, field.selectionStart);
			const line = upto.split("\n").length;
			const column = upto.length - upto.lastIndexOf("\n");
			return `ln ${line} col ${column}`;
		},
		/** True when the editor holds something the stored document does not. */
		artifactDirty() {
			return (
				!this.artifactStreaming &&
				Boolean(this.currentArtifact?.id) &&
				this.artifactSource !== (this.currentArtifact?.content ?? "")
			);
		},
		/**
		 * Save the edited source and show the result.
		 *
		 * The frame is keyed on the document's revision, so replacing
		 * currentArtifact with the server's copy is what makes the preview
		 * reload — a shader recompiles the moment this returns.
		 */
		async applyArtifactEdit() {
			if (!this.artifactDirty() || this.artifactSaving) return;
			this.artifactSaving = true;
			try {
				const response = await fetch(
					`./api/artifacts/${encodeURIComponent(this.currentArtifact.id)}`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ content: this.artifactSource }),
					},
				);
				if (!response.ok) return;
				this.currentArtifact = await response.json();
				this.artifactSource = this.currentArtifact.content || "";
				// Last run's complaint belongs to the last revision.
				this.artifactStatus = "";
				this.artifactView = "preview";
			} catch {
				/* Leave the edit in the box rather than losing it. */
			} finally {
				this.artifactSaving = false;
			}
		},
		/** Rendered documents get a frame; everything else is read as text. */
		artifactIsFramed() {
			return (
				this.artifactView === "preview" &&
				!this.artifactStreaming &&
				Boolean(this.currentArtifact?.id) &&
				["html", "svg", "glsl", "wgsl", "three", "lua"].includes(this.currentArtifact?.kind)
			);
		},
		/**
		 * Cache-busted per revision: an edit changes the document behind a URL
		 * that has not changed, and the frame would otherwise show the version
		 * from before the edit.
		 */
		artifactFrameSrc() {
			const artifact = this.currentArtifact;
			if (!artifact?.id) return "";
			return `./api/artifacts/${encodeURIComponent(artifact.id)}/document?v=${encodeURIComponent(artifact.updatedAt || "")}`;
		},
		/** Markdown and code artifacts go through the same rich-text renderer. */
		renderArtifactBody(element, artifact) {
			if (!element || !artifact) return;
			const fence = "```";
			const body =
				artifact.kind === "code"
					? [fence + (artifact.language || ""), artifact.content, fence].join(
							String.fromCharCode(10),
						)
					: artifact.content;
			this.renderMessageText(element, body);
		},
		downloadArtifact() {
			const artifact = this.currentArtifact;
			if (!artifact) return;
			const EXTENSIONS = {
				html: "html",
				svg: "svg",
				markdown: "md",
				glsl: "glsl",
				wgsl: "wgsl",
				three: "js",
				lua: "lua",
			};
			const extension =
				EXTENSIONS[artifact.kind] || artifact.language || "txt";
			const blob = new Blob([artifact.content], { type: "text/plain" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = `${artifact.title.replace(/[^\w.-]+/g, "-")}.${extension}`;
			link.click();
			URL.revokeObjectURL(url);
		},
		async deleteArtifact() {
			const artifact = this.currentArtifact;
			if (!artifact || !window.confirm(`Delete "${artifact.title}"?`)) return;
			await fetch(`./api/artifacts/${encodeURIComponent(artifact.id)}`, {
				method: "DELETE",
			});
			this.artifactOpen = false;
			this.currentArtifact = null;
		},
		formatBytes(value) {
			const bytes = Number(value || 0);
			if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}G`;
			if (bytes >= 1e6) return `${Math.round(bytes / 1e6)}M`;
			return `${Math.round(bytes / 1e3)}K`;
		},
		/**
		 * Poll host telemetry. Every five seconds is often enough to catch a
		 * thermal climb without adding load to the thing being measured, and
		 * it pauses while the tab is hidden.
		 */
		startSystemPolling() {
			const tick = async () => {
				if (document.hidden) return;
				try {
					const response = await fetch("./api/system");
					if (response.ok) this.system = await response.json();
				} catch {
					this.system = null;
				}
			};
			tick();
			clearInterval(this.systemTimer);
			this.systemTimer = setInterval(tick, 5000);
		},
		formatValue(value) {
			if (value === null || value === undefined) return "—";
			if (typeof value === "object") return JSON.stringify(value, null, 2);
			return String(value);
		},
		rgbHex(rgb) {
			const values = Array.isArray(rgb) ? rgb : [242, 184, 75];
			return `#${values
				.map((value) =>
					Math.max(0, Math.min(255, Number(value)))
						.toString(16)
						.padStart(2, "0"),
				)
				.join("")}`;
		},
		hexRgb(hex) {
			return [1, 3, 5].map((offset) =>
				Number.parseInt(hex.slice(offset, offset + 2), 16),
			);
		},
		// ── Entity card helpers ───────────────────────────────────────────────
		// Thin pass-throughs so the markup can stay declarative.
		iconPaths(entity) {
			return window.RemindMeEntityCards.iconPaths(entity);
		},
		iconTone(entity) {
			return window.RemindMeEntityCards.iconTone(entity);
		},
		isActive(entity) {
			return window.RemindMeEntityCards.isActive(entity);
		},
		statePill(entity) {
			return window.RemindMeEntityCards.statePill(entity);
		},
		showPill(entity) {
			return window.RemindMeEntityCards.showPill(entity);
		},
		fanSpeedLabel(entity) {
			return window.RemindMeEntityCards.fanSpeedLabel(entity);
		},
		compactDetail(entity) {
			return window.RemindMeEntityCards.compactDetail(entity);
		},
		/** A degree below target, clamped — the usual "turn it down a bit". */
		setbackTarget(entity) {
			const current = entity.targetTemperature ?? entity.currentTemperature ?? 20;
			const minimum = entity.minTemperature ?? 7;
			return Math.max(minimum, Math.round(current - 1));
		},
		stepFanSpeed(entity) {
			return this.entityAction(
				entity,
				"set_fan_speed",
				window.RemindMeEntityCards.nextFanSpeed(entity),
			);
		},
		fillTone(entity) {
			return window.RemindMeEntityCards.fillTone(entity);
		},
		barPercent(entity) {
			return window.RemindMeEntityCards.barPercent(entity);
		},
		formatDwell(entity) {
			return window.RemindMeEntityCards.formatDwell(entity);
		},
		metaLine(entity) {
			if (entity.message) return "SCHEDULED REMINDER";
			return window.RemindMeEntityCards.metaLine(entity);
		},
		/**
		 * Card shape for one item. Three or more results in a set collapse to
		 * compact rows no matter what the individual entities are.
		 */
		tierOf(entity, setSize) {
			if (entity.message) return "tier-controllable";
			if (setSize >= 3) return "tier-compact";
			return `tier-${entity.tier || "readout"}`;
		},
		/** Approximate warm-to-cool blackbody swatch for a colour temperature. */
		kelvinHex(kelvin) {
			return window.RemindMeEntityControls.kelvinHex(kelvin);
		},
		/*
		 * ── Card controls ────────────────────────────────────────────────
		 * A slider reads from the entity until you touch it, then from the
		 * draft. Without that the knob would snap back under your finger on
		 * every state push and land wherever the round trip left it.
		 */
		controlDraft: {},
		lightModes: {},
		/*
		 * ── The bench ────────────────────────────────────────────────────
		 * How much of the bench the artifact takes, 0-1, or null for the
		 * default split. A ratio rather than a pixel width, so a resized
		 * window keeps the proportion the user chose instead of stranding
		 * one case at a size that no longer fits.
		 */
		benchSplit: null,
		startBenchDrag(event) {
			const bench = document.querySelector(".workbench");
			if (!bench) return;
			const box = bench.getBoundingClientRect();
			const set = (clientX) => {
				const ratio = (box.right - clientX) / box.width;
				this.benchSplit = Math.min(0.75, Math.max(0.2, ratio));
			};
			set(event.clientX);
			/* On the window for the same reason the card sliders are: the
			 * pointer spends the whole drag away from the divider. */
			const move = (moveEvent) => set(moveEvent.clientX);
			const done = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", done);
				window.removeEventListener("pointercancel", done);
				document.body.classList.remove("resizing");
			};
			document.body.classList.add("resizing");
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", done);
			window.addEventListener("pointercancel", done);
		},
		nudgeBench(direction) {
			const current = this.benchSplit ?? this.defaultBenchSplit();
			this.benchSplit = Math.min(
				0.75,
				Math.max(0.2, current - direction * 0.02),
			);
		},
		/** Matches the flex-grow the stylesheet gives the artifact case. */
		defaultBenchSplit() {
			return 0.38;
		},
		controlKey(entity, channel) {
			return `${entity.entityId}:${channel}`;
		},
		/**
		 * Which sliders a card gets. Driven by what the device reports it can
		 * do, so a dimmable-only bulb never shows a colour control it would
		 * refuse, and a colour bulb shows one mood at a time.
		 */
		controlChannels(entity) {
			const can = entity.capabilities || {};
			if (entity.domain === "light") {
				const channels = can.brightness ? ["brightness"] : [];
				const colorMode = this.lightMode(entity) === "color";
				if (can.colorTemperature && (!can.color || !colorMode))
					channels.push("kelvin");
				if (can.color && (colorMode || !can.colorTemperature))
					channels.push("hue", "saturation");
				return channels;
			}
			if (entity.domain === "cover" && can.position) return ["position"];
			if (entity.domain === "fan" && entity.fanPercentage != null)
				return ["speed"];
			return [];
		},
		channelLabel(channel) {
			return window.RemindMeEntityControls.CHANNELS[channel].label;
		},
		channelMin(entity, channel) {
			return window.RemindMeEntityControls.bound(channel, "min", entity);
		},
		channelMax(entity, channel) {
			return window.RemindMeEntityControls.bound(channel, "max", entity);
		},
		controlValue(entity, channel) {
			const key = this.controlKey(entity, channel);
			if (key in this.controlDraft) return this.controlDraft[key];
			return window.RemindMeEntityControls.CHANNELS[channel].read(entity);
		},
		controlLabel(entity, channel) {
			return window.RemindMeEntityControls.CHANNELS[channel].format(
				this.controlValue(entity, channel),
				entity,
			);
		},
		controlPercent(entity, channel) {
			return window.RemindMeEntityControls.percentOf(
				this.controlValue(entity, channel),
				channel,
				entity,
			);
		},
		controlTrack(entity, channel) {
			return window.RemindMeEntityControls.trackGradient(channel, entity, {
				hue: this.controlValue(entity, "hue"),
				saturation: this.controlValue(entity, "saturation"),
			});
		},
		/**
		 * Drag, or click anywhere on the track. The draft follows the pointer
		 * so the bar moves under the finger; the service call goes out once,
		 * on release, rather than flooding Home Assistant mid-gesture.
		 */
		startControlDrag(event, entity, channel) {
			const track = event.currentTarget;
			const key = this.controlKey(entity, channel);
			const controls = window.RemindMeEntityControls;
			const set = (clientX) => {
				this.controlDraft[key] = controls.valueFromPointer(
					track,
					clientX,
					channel,
					entity,
				);
			};
			set(event.clientX);
			/*
			 * The window, not the track: a drag that leaves the six-pixel
			 * groove is still the same drag, and it has to keep tracking even
			 * when the pointer ends up over the card, the transcript or
			 * outside the document entirely.
			 */
			const move = (moveEvent) => set(moveEvent.clientX);
			const done = () => {
				window.removeEventListener("pointermove", move);
				window.removeEventListener("pointerup", done);
				window.removeEventListener("pointercancel", done);
				this.commitControl(entity, channel);
			};
			window.addEventListener("pointermove", move);
			window.addEventListener("pointerup", done);
			window.addEventListener("pointercancel", done);
		},
		/** Keyboard is the same control: a slider nobody can tab to is a bar. */
		nudgeControl(event, entity, channel, direction) {
			event.preventDefault();
			const controls = window.RemindMeEntityControls;
			const step = controls.bound(channel, "step", entity) || 1;
			const min = controls.bound(channel, "min", entity);
			const max = controls.bound(channel, "max", entity);
			const next = this.controlValue(entity, channel) + step * direction;
			this.controlDraft[this.controlKey(entity, channel)] = Math.min(
				max,
				Math.max(min, next),
			);
			this.commitControl(entity, channel);
		},
		async commitControl(entity, channel) {
			const key = this.controlKey(entity, channel);
			const value = this.controlDraft[key];
			if (value === undefined) return;
			const controls = window.RemindMeEntityControls;
			const draft = {
				hue: this.controlValue(entity, "hue"),
				saturation: this.controlValue(entity, "saturation"),
			};
			const [action, payload] = controls.CHANNELS[channel].commit(
				value,
				entity,
				draft,
			);
			/*
			 * Write the value onto the entity before dropping the draft. The
			 * bulb takes a moment to answer and the state push behind it takes
			 * longer; without this the knob would spring back to the old
			 * reading and then jump forward once the round trip landed.
			 */
			controls.CHANNELS[channel].apply(entity, value, draft);
			delete this.controlDraft[key];
			await this.entityAction(entity, action, payload);
		},
		/**
		 * Warm and colour are one bulb in two moods, and it cannot be in both.
		 * The mode is read from what the light is doing, until you say
		 * otherwise on this card.
		 */
		lightMode(entity) {
			const chosen = this.lightModes[entity.entityId];
			if (chosen) return chosen;
			return window.RemindMeEntityControls.isColorMode(entity)
				? "color"
				: "warm";
		},
		setLightMode(entity, mode) {
			this.lightModes[entity.entityId] = mode;
			/* Switching mode is itself the instruction: put the light there. */
			if (mode === "warm")
				return this.entityAction(
					entity,
					"color_temperature",
					Math.round(this.controlValue(entity, "kelvin")),
				);
			return this.entityAction(
				entity,
				"rgb_color",
				window.RemindMeEntityControls.hsvToRgb(
					this.controlValue(entity, "hue"),
					this.controlValue(entity, "saturation"),
					100,
				),
			);
		},
		stepTemperature(entity, direction) {
			const step = entity.temperatureStep || 0.5;
			const current = entity.targetTemperature ?? entity.currentTemperature ?? 20;
			this.entityAction(entity, "set_temperature", current + step * direction);
		},
		/**
		 * Sparklines need real history, so it is fetched per card after the card
		 * mounts rather than during the turn.
		 */
		/**
		 * Fetch history for a card and derive the line that actually answers
		 * the question it poses. A temperature card asks about drift, a
		 * humidity card about how long it has been high, a power card about
		 * the peak, a battery about the week, a door about today. One request
		 * per card, after it mounts, so a slow recorder never blocks a reply.
		 */
		async loadSpark(entity) {
			if (entity.sparkLoaded) return;
			entity.sparkLoaded = true;
			const cards = window.RemindMeEntityCards;
			const kind = entity.deviceClass;
			// Battery drifts over days; everything else over hours.
			const hours = kind === "battery" ? 168 : 6;
			const windowLabel = kind === "battery" ? "7 DAYS" : `${hours}H`;
			const history = await cards.loadHistory(entity, hours);
			if (!history) return;
			const points = history.points || [];
			const changes = history.changes || [];

			if (entity.measurement === "sparkline" && points.length > 1)
				entity.sparkPoints = cards.sparklinePoints(points);

			const parts = [];
			if (kind === "power" || kind === "energy")
				parts.push(cards.summarizePeak(points, entity.unit));
			else if (kind === "humidity" || kind === "moisture")
				parts.push(cards.summarizeThreshold(points, 60, entity.unit));
			else if (kind === "battery")
				parts.push(cards.summarizeDrift(points, entity.unit, windowLabel));
			else if (entity.domain === "binary_sensor")
				parts.push(cards.summarizeEvents(changes, "on"));
			else if (points.length > 1)
				parts.push(cards.summarizeTrend(points, entity.unit, windowLabel));

			const summary = parts.filter(Boolean).join(" · ");
			if (summary) entity.sparkSummary = summary;
		},
		get enabledSkillCount() {
			return this.skills.filter((skill) => skill.enabled).length;
		},
		/** Rough cost of what enabled skills add to every request. */
		get skillTokenCost() {
			const text = this.skills
				.filter((skill) => skill.enabled)
				.map((skill) => `${skill.name}: ${skill.instructions}`)
				.join("\n");
			return Math.ceil(text.length / 4);
		},
		/** Probe each layer to the model manager and show where it breaks. */
		async runModelDiagnostics() {
			this.modelDiagnostics = null;
			try {
				const response = await fetch("./api/models/diagnostics");
				this.modelDiagnostics = await response.json();
			} catch (error) {
				this.modelDiagnostics = {
					ok: false,
					checks: [
						{ step: "harness", ok: false, detail: String(error.message || error) },
					],
				};
			}
		},
		async openMcp() {
			this.mcpOpen = true;
			await this.loadMcp();
		},
		async loadMcp() {
			try {
				const response = await fetch("./api/mcp");
				this.mcpServers = response.ok ? await response.json() : [];
			} catch {
				this.mcpError = "Could not load MCP servers.";
			}
		},
		async addMcp() {
			const name = this.newMcpName.trim();
			const url = this.newMcpUrl.trim();
			if (!name || !url) {
				this.mcpError = "A server needs a name and a URL.";
				return;
			}
			this.mcpError = "";
			const response = await fetch("./api/mcp", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					url,
					authorization: this.newMcpAuth.trim() || undefined,
					enabled: true,
				}),
			});
			const body = await response.json();
			if (!response.ok) {
				this.mcpError = body.error || "Could not add the server.";
				return;
			}
			this.mcpServers.unshift(body);
			this.newMcpName = "";
			this.newMcpUrl = "";
			this.newMcpAuth = "";
		},
		async updateMcp(server, values) {
			const response = await fetch(`./api/mcp/${encodeURIComponent(server.id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(values),
			});
			const body = await response.json();
			if (!response.ok) {
				this.mcpError = body.error || "Could not update the server.";
				return;
			}
			Object.assign(server, body);
		},
		/** Handshake and list tools, so a server can be checked before use. */
		async testMcp(server) {
			server.probe = "Connecting…";
			try {
				const response = await fetch(
					`./api/mcp/${encodeURIComponent(server.id)}/test`,
					{ method: "POST" },
				);
				const body = await response.json();
				server.probe = body.ok
					? `${body.serverName || "connected"} — ${body.tools.length} tool(s): ${body.tools
							.map((tool) => tool.name)
							.join(", ")}`
					: `Failed: ${body.error}`;
			} catch (error) {
				server.probe = `Failed: ${error.message || error}`;
			}
		},
		async deleteMcp(server) {
			if (!window.confirm(`Remove "${server.name}"?`)) return;
			const response = await fetch(`./api/mcp/${encodeURIComponent(server.id)}`, {
				method: "DELETE",
			});
			if (!response.ok && response.status !== 404) {
				this.mcpError = "Could not remove the server.";
				return;
			}
			this.mcpServers = this.mcpServers.filter((entry) => entry.id !== server.id);
		},
		async openSkills() {
			this.skillsOpen = true;
			await this.loadSkills();
		},
		async loadSkills() {
			try {
				const response = await fetch("./api/skills");
				this.skills = response.ok ? await response.json() : [];
			} catch {
				this.skillError = "Could not load skills.";
			}
		},
		async addSkill() {
			const name = this.newSkillName.trim();
			const instructions = this.newSkillBody.trim();
			if (!name || !instructions) {
				this.skillError = "A skill needs both a name and instructions.";
				return;
			}
			this.skillError = "";
			const response = await fetch("./api/skills", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, instructions, enabled: true }),
			});
			if (!response.ok) {
				this.skillError = "Could not save the skill.";
				return;
			}
			this.skills.unshift(await response.json());
			this.newSkillName = "";
			this.newSkillBody = "";
		},
		async updateSkill(skill, values) {
			const response = await fetch(
				`./api/skills/${encodeURIComponent(skill.id)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(values),
				},
			);
			if (!response.ok) {
				this.skillError = "Could not update the skill.";
				return;
			}
			Object.assign(skill, await response.json());
		},
		toggleSkill(skill, enabled) {
			return this.updateSkill(skill, { enabled });
		},
		async deleteSkill(skill) {
			if (!window.confirm(`Delete the skill "${skill.name}"?`)) return;
			const response = await fetch(
				`./api/skills/${encodeURIComponent(skill.id)}`,
				{ method: "DELETE" },
			);
			if (!response.ok && response.status !== 404) {
				this.skillError = "Could not delete the skill.";
				return;
			}
			this.skills = this.skills.filter((entry) => entry.id !== skill.id);
		},
		/**
		 * Local commands are answered by the console itself and never reach the
		 * model — no tokens spent listing your own capabilities.
		 */
		/**
		 * Local commands are answered by the console and never reach the model.
		 * See components/commands.js for the set.
		 */
		async runLocalCommand(text) {
			if (!window.RemindMeCommands) return false;
			return window.RemindMeCommands.run(this, text);
		},
		/** Delete a conversation. Confirmed first — it is not recoverable. */
		async deleteConversation(conversation) {
			if (
				!window.confirm(
					`Delete "${conversation.title || "this conversation"}"? This cannot be undone.`,
				)
			)
				return;
			await window.RemindMeConversations.remove(this, conversation);
		},
		async entityAction(entity, action, value) {
			const outcome = await window.RemindMeEntities.performEntityAction(
				entity,
				action,
				value,
			);
			if (outcome.confirmation)
				this.add("tool", outcome.confirmation.message, {
					label: "CONFIRMATION REQUIRED",
					confirm: outcome.confirmation,
				});
			this.persist();
		},
		/** The unwritten remainder of the command being typed. */
		get commandGhost() {
			return window.RemindMeCommands
				? window.RemindMeCommands.ghost(this.draft)
				: "";
		},
		get commandMatches() {
			return window.RemindMeCommands
				? window.RemindMeCommands.matching(this.draft)
				: [];
		},
		acceptGhost() {
			const rest = this.commandGhost;
			if (!rest) return false;
			this.draft += rest;
			return true;
		},
		handleComposerKeydown(event) {
			// Tab and Right-at-the-end accept the suggestion, as a shell does.
			if (this.commandGhost) {
				const atEnd =
					event.target.selectionStart === this.draft.length &&
					event.target.selectionEnd === this.draft.length;
				if (event.key === "Tab" || (event.key === "ArrowRight" && atEnd)) {
					event.preventDefault();
					this.acceptGhost();
					return;
				}
			}
			return window.RemindMeComposer.handleKeydown(this, event);
		},
		resizeComposer(event) {
			const textarea = event?.target;
			if (!textarea) return;
			textarea.style.height = "auto";
			const nextHeight = Math.min(textarea.scrollHeight, 160);
			textarea.style.height = `${nextHeight}px`;
			textarea.style.overflowY =
				textarea.scrollHeight > 160 ? "auto" : "hidden";
		},
		async addAttachments(files) {
			this.attachmentError = "";
			await window.RemindMeAttachments.addFiles(this, files || []);
		},
		async send() {
			const text = this.draft.trim();
			if (!text || this.busy) return;
			this.draft = "";
			if (await this.runLocalCommand(text)) {
				this.$nextTick(() =>
					this.resizeComposer({ target: this.$refs.composerInput }),
				);
				this.persist();
				return;
			}
			this.$nextTick(() =>
				this.resizeComposer({ target: this.$refs.composerInput }),
			);
			// Adopt or create a conversation before the first message lands, so
			// there is always somewhere for save() to write.
			await window.RemindMeConversations.ensure(this);
			// Captured before the new turn joins the transcript: it travels as
			// `message`, and sending it twice would have the model answer an
			// echo of the question.
			const history = this.modelHistory();
			this.add("user", text);
			this.busy = true;
			this.startActivity("Working");
			this.scrollToBottom(true);
			this.abortController = new AbortController();
			try {
				const r = await fetch("./api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					signal: this.abortController.signal,
					body: JSON.stringify({
						message: text,
						history,
						// What is on the bench, so "change the footer" has a target.
						artifactId: this.artifactOpen ? this.currentArtifact?.id || "" : "",
						thinkingMode: this.thinking,
						attachments: this.attachments,
					}),
				});
				if (!r.ok || !r.body)
					throw new Error("The local model stream did not start.");
				const reader = r.body.getReader(),
					decoder = new TextDecoder();
				let buffer = "",
					event = "";
				while (true) {
					const chunk = await reader.read();
					if (chunk.done) break;
					buffer += decoder.decode(chunk.value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (line.startsWith("event: ")) event = line.slice(7);
						if (!line.startsWith("data: ")) continue;
						const data = JSON.parse(line.slice(6));
						if (
							[
								"phase_start",
								"thinking_delta",
								"tool_start",
								"tool_complete",
								"answer_delta",
								"answer",
								"phase_metrics",
								"phase_complete",
							].includes(event)
						) {
							this.messages = window.RemindMeTimeline.applyHarnessEvent(
								this.messages,
								event,
								data,
							);
							this.scrollToBottom();
							if (event === "phase_start")
								this.setActivityLabel(
									data.kind === "thinking" ? "Thinking" : "Working",
								);
							if (event === "tool_start")
								this.setActivityLabel(
									`Calling ${String(data.name || "tool").replaceAll("_", " ")}`,
								);
							if (event === "answer_delta") this.setActivityLabel("Replying");
							// A saved document, from a fresh write or an edit.
							if (event === "tool_complete" && data.view?.artifact)
								this.settleArtifact(data.view.artifact);
							if (event === "phase_metrics") {
								this.metrics = {
									inputTokens: data.metrics.inputTokens,
									decode: data.metrics.decodeTokensPerSecond,
									ttft: data.metrics.firstTokenMs,
									context:
										(data.metrics.inputTokens || 0) +
										(data.metrics.outputTokens || 0),
									thinking: data.metrics.thinkingTokens,
								};
							}
						} else if (event === "artifact_draft") {
							this.beginArtifactDraft(data);
							this.setActivityLabel("Writing document");
						} else if (event === "artifact_delta") {
							this.appendArtifactDraft(data);
						} else if (event === "error") throw new Error(data.message);
						this.persist();
					}
				}
			} catch (error) {
				// An abort is a user decision, not a fault: no error, no offline flag.
				if (error.name === "AbortError") this.add("answer", "Cancelled.");
				else {
					this.add("answer", "ERROR // " + error.message);
					this.offline = true;
				}
			} finally {
				/*
				 * A cancelled or failed turn leaves a half-written draft on the
				 * bench. Stop calling it a write in progress — the text stays
				 * readable, but nothing pretends it is still coming.
				 */
				this.artifactStreaming = false;
				this.abortController = null;
				this.stopActivity();
				this.busy = false;
				if (!this.offline) this.attachments = [];
				this.persist();
			}
		},
		/**
		 * Keep the newest content in view, but only when the reader is already
		 * near the bottom — scrolling someone back down while they are reading
		 * history is worse than letting the throbber sit off-screen.
		 */
		scrollToBottom(force = false) {
			this.$nextTick(() => {
				const chat = document.getElementById("timeline");
				if (!chat) return;
				const distance =
					chat.scrollHeight - chat.scrollTop - chat.clientHeight;
				if (force || distance < 140) chat.scrollTop = chat.scrollHeight;
			});
		},
		startActivity(label) {
			this.activity = { label, startedAt: Date.now() };
			this.activityElapsed = 0;
			clearInterval(this.activityTimer);
			this.activityTimer = setInterval(() => {
				if (!this.activity) return;
				this.activityElapsed = (Date.now() - this.activity.startedAt) / 1000;
			}, 100);
		},
		/** Retitle the running activity row without restarting its clock. */
		setActivityLabel(label) {
			if (this.activity && this.activity.label !== label)
				this.activity = { ...this.activity, label };
		},
		stopActivity() {
			if (!this.activity && !this.activityTimer) return;
			clearInterval(this.activityTimer);
			this.activityTimer = null;
			this.activity = null;
		},
		/** Abort the in-flight turn. The server sees the stream close. */
		cancel() {
			if (this.abortController) this.abortController.abort();
		},
		handleTool(data) {
			if (data.state === "running")
				this.add("tool", `${data.name} // running`, {
					label: "TOOL BUS",
					text: `${data.name} // running`,
				});
			if (data.state !== "complete") return;
			if (data.result?.confirmation_required)
				this.add("tool", data.result.message, {
					label: "CONFIRMATION REQUIRED",
					confirm: data.result,
				});
			else if (Array.isArray(data.result))
				this.add("answer", "", {
					label: data.name,
					items: data.result,
				});
			else
				this.add("tool", `${data.name} // complete`, {
					label: "TOOL BUS",
				});
		},
		async confirmAction(message) {
			const confirm = message.confirm;
			const r = await fetch("./api/confirm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: confirm.token }),
			});
			// Say what was actually committed — a reminder set, not a generic
			// "action applied" that reads the same for every confirmation.
			if (r.ok)
				message.text =
					confirm.kind === "reminder"
						? `Reminder set for ${confirm.when}.`
						: "Action applied.";
			else message.text = "Action failed.";
			message.confirm = null;
			this.persist();
		},
		/* ── Task wizard ──────────────────────────────────────────────── */
		/** Drop an inline task-builder card into the transcript. */
		openTaskWizard() {
			return this.add("wizard", "", {
				label: "TASK WIZARD",
				wizard: {
					what: "",
					when: "",
					vault: true,
					notify: true,
					error: "",
					submitting: false,
				},
			});
		},
		async submitTaskWizard(message) {
			const wizard = message.wizard;
			wizard.error = "";
			if (!wizard.what.trim()) {
				wizard.error = "Say what the task should do.";
				return;
			}
			if (!wizard.when.trim()) {
				wizard.error = "Say when — e.g. 'every day at 8'.";
				return;
			}
			const deliver = [];
			if (wizard.vault) deliver.push("vault");
			if (wizard.notify) deliver.push("notify");
			if (!deliver.length) {
				wizard.error = "Pick at least one delivery target.";
				return;
			}
			wizard.submitting = true;
			try {
				const response = await fetch("./api/tasks", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						prompt: wizard.what.trim(),
						text: wizard.when.trim(),
						deliver,
					}),
				});
				const data = await response.json().catch(() => ({}));
				if (!response.ok) {
					wizard.error = data.error || "Could not schedule the task.";
					wizard.submitting = false;
					return;
				}
				// Collapse the form into a plain confirmation line, which then
				// persists like any other answer.
				message.wizard = null;
				message.kind = "answer";
				message.text = `Scheduled **${data.name}** — ${data.scheduleText}. First run ${new Date(data.nextRun).toLocaleString()}.`;
				this.persist();
			} catch (error) {
				wizard.error = error.message || "Network error.";
				wizard.submitting = false;
			}
		},
		cancelTaskWizard(message) {
			message.wizard = null;
			message.kind = "answer";
			message.text = "Task wizard closed.";
			this.persist();
		},
		/* ── Vault graph ──────────────────────────────────────────────────
		 * The vault's relations, drawn in the transcript. Same-origin, so it
		 * fetches its own data — an artifact frame is sandboxed off the network,
		 * and this needs /api/vault/graph. Notes cluster by their leading tag;
		 * [[wikilinks]] are the solid edges between them.
		 */
		graphPalette: [
			"#ffb200",
			"#e0872f",
			"#d9a441",
			"#c96f3a",
			"#e6c34b",
			"#b8862f",
			"#d9694b",
			"#9c7bd9",
		],
		graphColor(key) {
			let hash = 0;
			for (let i = 0; i < key.length; i += 1)
				hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
			return this.graphPalette[hash % this.graphPalette.length];
		},
		computeGraphLayout(nodes, edges) {
			// Cluster each note under its leading tag (or "untagged"), lay the
			// clusters out on a big ring, and spread each cluster's notes on a
			// small ring around their hub — the same hub-and-spoke shape the
			// constellation's relation map uses.
			const clusters = new Map();
			for (const node of nodes) {
				const tag = (node.tags && node.tags[0]) || "untagged";
				if (!clusters.has(tag)) clusters.set(tag, []);
				clusters.get(tag).push(node);
			}
			const cx = 420;
			const cy = 320;
			const clusterR = clusters.size > 1 ? 230 : 0;
			const hubs = [];
			const placed = new Map();
			const laidNodes = [];
			let ci = 0;
			for (const [tag, members] of clusters) {
				const hubAngle = (ci / clusters.size) * Math.PI * 2 - Math.PI / 2;
				const hx = cx + Math.cos(hubAngle) * clusterR;
				const hy = cy + Math.sin(hubAngle) * clusterR;
				const color = this.graphColor(tag);
				hubs.push({ tag, x: hx, y: hy, color, count: members.length });
				const nodeR = Math.min(140, 34 + members.length * 9);
				members.forEach((node, ni) => {
					const a =
						members.length === 1
							? hubAngle
							: (ni / members.length) * Math.PI * 2;
					const x = hx + Math.cos(a) * (members.length === 1 ? 0 : nodeR);
					const y = hy + Math.sin(a) * (members.length === 1 ? 0 : nodeR);
					placed.set(node.id, { x, y });
					laidNodes.push({
						id: node.id,
						title: node.title,
						x,
						y,
						color,
						tag,
						degree: node.degree || 0,
					});
				});
				ci += 1;
			}
			// Only link edges between notes we actually placed.
			const laidEdges = [];
			for (const edge of edges || []) {
				if (edge.kind !== "link") continue;
				const a = placed.get(edge.source);
				const b = placed.get(edge.target);
				if (a && b) laidEdges.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
			}
			const graph = {
				nodes: laidNodes,
				edges: laidEdges,
				hubs,
				view: { x: 0, y: 0, w: 840, h: 640 },
			};
			// Pre-render the drawing as an SVG string. Alpine's <template x-for>
			// clones nodes in the HTML namespace, so SVG children built that way
			// never paint; setting innerHTML on a real <svg> parses them in the
			// SVG namespace instead. Click handling is delegated, keyed by
			// data-path on each node group.
			graph.svg = this.buildGraphSvg(graph);
			return graph;
		},
		buildGraphSvg(graph) {
			const esc = (value) =>
				String(value).replace(
					/[<>&"]/g,
					(c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c],
				);
			const clip = (title) =>
				title.length > 18 ? `${title.slice(0, 17)}…` : title;
			let svg = "";
			for (const edge of graph.edges)
				svg += `<line x1="${edge.x1}" y1="${edge.y1}" x2="${edge.x2}" y2="${edge.y2}" stroke="#8a5c00" stroke-opacity="0.5" stroke-width="1"/>`;
			for (const hub of graph.hubs)
				svg += `<circle cx="${hub.x}" cy="${hub.y}" r="7" fill="${hub.color}" fill-opacity="0.45"/><text x="${hub.x}" y="${hub.y - 12}" text-anchor="middle" font-size="13" fill="${hub.color}">#${esc(hub.tag)}</text>`;
			for (const node of graph.nodes) {
				const r = 6 + Math.min(6, node.degree);
				svg += `<g class="vg-node" data-path="${esc(node.id)}"><title>${esc(node.title)}</title><circle cx="${node.x}" cy="${node.y}" r="${r}" fill="${node.color}"/><text x="${node.x}" y="${node.y + 18}" text-anchor="middle" font-size="10" fill="#b98f3a">${esc(clip(node.title))}</text></g>`;
			}
			return svg;
		},
		/**
		 * Inject the pre-built SVG string as real SVG nodes.
		 *
		 * Setting innerHTML on an <svg> parses its children in the HTML
		 * namespace, where <circle> and <line> are unknown elements that never
		 * paint. Parsing the string as an SVG document and importing the nodes
		 * keeps them in the SVG namespace, so they render.
		 */
		renderGraphInto(el, graph) {
			// viewBox is set imperatively here and in the pan/zoom handlers:
			// Alpine's :viewBox binding does not reliably apply the camelCased
			// SVG attribute, which left the drawing off-canvas.
			if (el) this.applyGraphView(el, graph.view);
			if (!el || el.dataset.rendered === graph.svg) return;
			while (el.firstChild) el.removeChild(el.firstChild);
			const doc = new DOMParser().parseFromString(
				`<svg xmlns="http://www.w3.org/2000/svg">${graph.svg}</svg>`,
				"image/svg+xml",
			);
			// Snapshot the children first: importNode clones without detaching
			// from the source, so iterating firstChild would never advance.
			for (const child of Array.from(doc.documentElement.childNodes))
				el.appendChild(document.importNode(child, true));
			el.dataset.rendered = graph.svg;
		},
		applyGraphView(el, view) {
			el.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
		},
		/* A click anywhere in the SVG resolves to the nearest note group. */
		graphClick(event) {
			if (this._graphPanned) return;
			const group = event.target.closest?.("[data-path]");
			if (group) this.graphOpenNote({ id: group.getAttribute("data-path") });
		},
		async openVaultGraph(query) {
			const [graph, tags] = await Promise.all([
				fetch("./api/vault/graph")
					.then((r) => (r.ok ? r.json() : { nodes: [], edges: [] }))
					.catch(() => ({ nodes: [], edges: [] })),
				fetch("./api/vault/tags")
					.then((r) => (r.ok ? r.json() : []))
					.catch(() => []),
			]);
			let notes = (graph.nodes || []).filter((node) => node.kind !== "tag");
			if (query) {
				const q = query.toLowerCase();
				notes = notes.filter(
					(node) =>
						node.title.toLowerCase().includes(q) ||
						(node.tags || []).some((tag) => tag.includes(q)),
				);
			}
			if (!notes.length) {
				this.add(
					"answer",
					query
						? `No notes match \`${query}\`.`
						: "The vault is empty. Save a note and it will appear here.",
				);
				return;
			}
			const layout = this.computeGraphLayout(notes, graph.edges);
			this.add("graph", "", {
				label: "VAULT GRAPH",
				graph: layout,
				graphMeta: `${notes.length} notes · ${layout.edges.length} links · ${tags.length} tags`,
			});
		},
		/** A node tap reads the note into the transcript. */
		async graphOpenNote(node) {
			const response = await fetch(
				`./api/vault/note?path=${encodeURIComponent(node.id)}`,
			);
			if (!response.ok) return this.add("answer", `Could not open ${node.id}.`);
			const note = await response.json();
			const tags = (note.tags || []).map((tag) => `#${tag}`).join(" ");
			this.add(
				"answer",
				[`### ${note.title}`, tags, "", note.body || "*(empty note)*"]
					.filter((line) => line !== "")
					.join("\n"),
			);
		},
		/* Pan and zoom act on the tapped graph's own viewBox. */
		graphPanStart(message, event) {
			this._graphDrag = {
				message,
				x: event.clientX,
				y: event.clientY,
				vx: message.graph.view.x,
				vy: message.graph.view.y,
				rect: event.currentTarget.getBoundingClientRect(),
				moved: false,
			};
		},
		graphPanMove(event) {
			const drag = this._graphDrag;
			if (!drag) return;
			const view = drag.message.graph.view;
			const dx = ((event.clientX - drag.x) * view.w) / drag.rect.width;
			const dy = ((event.clientY - drag.y) * view.h) / drag.rect.height;
			if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3)
				drag.moved = true;
			view.x = drag.vx - dx;
			view.y = drag.vy - dy;
			this.applyGraphView(event.currentTarget, view);
		},
		graphPanEnd() {
			this._graphDrag = null;
		},
		graphZoom(message, event) {
			event.preventDefault();
			const view = message.graph.view;
			const rect = event.currentTarget.getBoundingClientRect();
			const mx = view.x + ((event.clientX - rect.left) / rect.width) * view.w;
			const my = view.y + ((event.clientY - rect.top) / rect.height) * view.h;
			const factor = event.deltaY > 0 ? 1.12 : 0.89;
			const nw = Math.min(2400, Math.max(220, view.w * factor));
			const k = nw / view.w;
			view.x = mx - (mx - view.x) * k;
			view.y = my - (my - view.y) * k;
			view.w = nw;
			view.h *= k;
			this.applyGraphView(event.currentTarget, view);
		},
		cancelAction(message) {
			message.text = "Action cancelled.";
			message.confirm = null;
			this.persist();
		},
		async deleteReminder(id) {
			await fetch("./api/reminders/" + encodeURIComponent(id), {
				method: "DELETE",
			});
			this.messages = this.messages.map((m) =>
				m.items ? { ...m, items: m.items.filter((i) => i.id !== id) } : m,
			);
			this.persist();
		},
		async reloadModels() {
			return window.RemindMeModelCookbook.load(this);
		},
		async pairModelManager() {
			return window.RemindMeModelCookbook.pair(this);
		},
		async downloadModel(id) {
			return window.RemindMeModelCookbook.download(this, id);
		},
		async copyModelYaml(id) {
			return window.RemindMeModelCookbook.copyYaml(this, id);
		},
		async downloadModelYaml(id) {
			return window.RemindMeModelCookbook.downloadYaml(this, id);
		},
		async cancelModelOperation() {
			return window.RemindMeModelCookbook.cancel(this);
		},
		async removeModel(id) {
			return window.RemindMeModelCookbook.remove(this, id);
		},
		async saveModelToken() {
			return window.RemindMeModelCookbook.saveToken(this);
		},
		async saveCustomModel() {
			return window.RemindMeModelCookbook.saveCustom(this);
		},
		formatModelBytes(bytes) {
			return window.RemindMeModelCookbook.formatBytes(bytes);
		},
		modelProgressPercent() {
			return window.RemindMeModelCookbook.progressPercent(this.modelOperation);
		},
	};
}

/*
 * Full-viewport ASCII field: layered sine waves, no radial ripple term.
 * Deliberately subtle — " .:-=+" only, low opacity, slow time step. Skipped
 * entirely under prefers-reduced-motion, and paused when the tab is hidden so
 * it costs nothing on a Pi that is also running inference.
 */
(function asciiField() {
	const target = document.getElementById("ascii");
	if (!target) return;
	if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

	const CHARS = " .:-=+";
	/* Vertical advance is set by line-height, so rows can use it directly. */
	const LINE = 12;
	let cols = 0;
	let rows = 0;
	let time = 0;
	let frame = 0;

	/**
	 * Measure the real horizontal advance rather than assuming it equals the
	 * line height. At font-size:12px a monospace glyph advances ~7.2px, plus
	 * letter-spacing — assuming 12px yields far too few columns and leaves the
	 * right side of the viewport blank.
	 */
	function cellWidth() {
		const probe = document.createElement("span");
		const style = getComputedStyle(target);
		probe.textContent = "0".repeat(100);
		probe.style.cssText =
			`position:absolute;visibility:hidden;white-space:pre;` +
			`font-family:${style.fontFamily};font-size:${style.fontSize};` +
			`letter-spacing:${style.letterSpacing};`;
		document.body.appendChild(probe);
		const width = probe.getBoundingClientRect().width / 100;
		probe.remove();
		return width > 0 ? width : 8.2;
	}

	function resize() {
		cols = Math.ceil(window.innerWidth / cellWidth()) + 2;
		rows = Math.ceil(window.innerHeight / LINE) + 2;
	}

	function paint() {
		time += 0.014;
		let out = "";
		for (let y = 0; y < rows; y += 1) {
			let line = "";
			for (let x = 0; x < cols; x += 1) {
				const value =
					Math.sin(x * 0.13 + time) +
					Math.sin(y * 0.09 - time * 0.8) +
					Math.sin((x + y) * 0.05 + time * 0.4);
				const normalized = (value + 3) / 6;
				const index = Math.max(
					0,
					Math.min(CHARS.length - 1, Math.floor(normalized * CHARS.length)),
				);
				line += CHARS[index];
			}
			out += `${line}\n`;
		}
		target.textContent = out;
		frame = requestAnimationFrame(paint);
	}

	function start() {
		if (!frame) frame = requestAnimationFrame(paint);
	}
	function stop() {
		if (frame) cancelAnimationFrame(frame);
		frame = 0;
	}

	resize();
	window.addEventListener("resize", resize);
	document.addEventListener("visibilitychange", () =>
		document.hidden ? stop() : start(),
	);
	start();
})();
