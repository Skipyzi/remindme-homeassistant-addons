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
		thinking: localStorage.getItem("remindme.profile") || "fast",
		profile: localStorage.getItem("remindme.profile") || "fast",
		busy: false,
		settingsOpen: false,
		historyOpen: false,
		boardOpen: false,
		offline: false,
		scanlines: true,
		glow: 55,
		settingsMessage: "",
		settings: {
			localLlmUrl: "",
			model: "",
			exaApiKey: "",
			notifyTarget: "",
			hardwareProfile: null,
		},
		modelBadge: "LOCAL • QWEN",
		sessionLabel: "ready // private network",
		hardware: "raspberry pi profile",
		metrics: {},
		tokenUsage: {
			exact: false,
			promptTokens: 0,
			contextTokens: 0,
			contextCapacity: 8192,
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
			this.$watch("profile", (v) => {
				this.thinking = v;
				localStorage.setItem("remindme.profile", v);
			});
			this.$watch("draft", () => window.RemindMeComposer.measure(this));
			window.RemindMeComposer.measure(this, 0);
			window.RemindMeConversations.load(this).catch(() => {});
			fetch("./api/status")
				.then((r) => r.json())
				.then((d) => {
					this.modelBadge = "LOCAL • " + d.model;
					this.visionEnabled = Boolean(d.vision);
					if (d.hardware)
						this.hardware = `${d.hardware.architecture} / ${d.hardware.cpuCores} cores`;
				})
				.catch(() => {
					this.offline = true;
				});
			fetch("./api/settings")
				.then((r) => r.json())
				.then((d) => {
					this.settings.localLlmUrl = d.localLlmUrl;
					this.settings.model = d.model;
					this.settings.notifyTarget = d.notifyTarget
						? `notify.${d.notifyTarget.replace(/^notify\./, "")}`
						: "";
					this.settings.hardwareProfile = d.hardwareProfile;
				})
				.catch(() => {});
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
			return message;
		},
		async newChat() {
			await window.RemindMeConversations.create(this);
			this.add("assistant", "Fresh channel. What are we checking?");
		},
		selectConversation(conversation) {
			window.RemindMeConversations.select(this, conversation);
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
		async addAttachments(files) {
			this.attachmentError = "";
			await window.RemindMeAttachments.addFiles(this, files || []);
		},
		async send() {
			const text = this.draft.trim();
			if (!text || this.busy) return;
			this.draft = "";
			this.add("user", text);
			this.busy = true;
			try {
				const r = await fetch("./api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
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
								"phase_metrics",
								"phase_complete",
							].includes(event)
						) {
							this.messages = window.RemindMeTimeline.applyHarnessEvent(
								this.messages,
								event,
								data,
							);
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
				this.add("assistant", "ERROR // " + error.message);
				this.offline = true;
			} finally {
				this.busy = false;
				if (!this.offline) this.attachments = [];
				this.persist();
			}
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
		async saveSettings() {
			this.settingsMessage = "Saving…";
			const r = await fetch("./api/settings", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(this.settings),
			});
			this.settingsMessage = r.ok
				? "Saved. Restart the add-on to apply connection changes."
				: "Save failed.";
		},
	};
}
