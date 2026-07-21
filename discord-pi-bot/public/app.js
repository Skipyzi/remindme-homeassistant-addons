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
			fetch("./api/status")
				.then((r) => r.json())
				.then((d) => {
					this.modelBadge = "LOCAL • " + (d.modelName || d.model);
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
				})
				.catch(() => {
					this.offline = true;
				});
			window.RemindMeModelCookbook.load(this);
			this.startSystemPolling();
		},
		persist() {
			localStorage.setItem(
				"remindme.history",
				JSON.stringify(
					this.messages.map((message) => ({ ...message, confirm: undefined })),
				),
			);
			window.RemindMeConversations.save(this);
		},
		restore() {
			try {
				const saved = JSON.parse(
					localStorage.getItem("remindme.history") || "[]",
				);
				if (Array.isArray(saved)) this.messages = saved;
			} catch (_) {}
		},
		add(type, text, extra = {}) {
			const message = {
				id: `${Date.now()}-${Math.random()}`,
				type,
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
			this.add("assistant", "Fresh channel. What are we checking?");
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
				this.artifactOpen = true;
			} catch {
				/* nothing to show */
			}
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
			const extension =
				artifact.kind === "html"
					? "html"
					: artifact.kind === "svg"
						? "svg"
						: artifact.kind === "markdown"
							? "md"
							: artifact.language || "txt";
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
			const table = {
				2200: "#ff7a3c",
				2700: "#ffb200",
				4000: "#ffd9a0",
				6500: "#9fd8f0",
			};
			return table[kelvin] || "#ffb200";
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
						} else if (event === "error") throw new Error(data.message);
						this.persist();
					}
				}
			} catch (error) {
				// An abort is a user decision, not a fault: no error, no offline flag.
				if (error.name === "AbortError") this.add("assistant", "Cancelled.");
				else {
					this.add("assistant", "ERROR // " + error.message);
					this.offline = true;
				}
			} finally {
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
				this.add("assistant", "", {
					label: data.name,
					items: data.result,
				});
			else
				this.add("tool", `${data.name} // complete`, {
					label: "TOOL BUS",
				});
		},
		async confirmAction(message) {
			const r = await fetch("./api/confirm", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: message.confirm.token }),
			});
			message.text = r.ok ? "Action applied." : "Action failed.";
			message.confirm = null;
			this.persist();
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
