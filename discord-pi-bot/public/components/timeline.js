(function exposeTimeline(globalScope) {
	function recentTraceLines(text, count = 3) {
		return String(text || "")
			.split("\n")
			.filter(Boolean)
			.slice(-count)
			.join("\n");
	}

	function upsert(entries, key, create, update) {
		const index = entries.findIndex((entry) => entry.key === key);
		if (index < 0) return [...entries, create()];
		return entries.map((entry, current) =>
			current === index ? update({ ...entry }) : entry,
		);
	}

	/**
	 * Merge phase-level metrics into an entry without discarding what the
	 * entry knows about itself.
	 *
	 * phase_metrics arrives before a phase's tool calls and phase_complete
	 * after, and both used to overwrite `metrics` outright — so a tool row's
	 * toolResultTokens, set at tool_complete, was wiped moments later and the
	 * context a tool fed back never appeared anywhere.
	 */
	function mergeMetrics(entry, incoming) {
		if (!incoming) return entry.metrics;
		const kept = entry.metrics || {};
		return {
			...kept,
			...incoming,
			toolResultTokens: incoming.toolResultTokens || kept.toolResultTokens || 0,
		};
	}

	function applyHarnessEvent(entries, event, data) {
		const phaseId = data.phaseId || `legacy-${Date.now()}`;
		if (event === "phase_start") {
			if (data.kind !== "thinking") return entries;
			return upsert(
				entries,
				`${phaseId}:thinking`,
				() => ({
					key: `${phaseId}:thinking`,
					phaseId,
					kind: "thinking",
					state: "active",
					text: "",
					startedAt: Date.now(),
					expanded: false,
				}),
				(entry) => entry,
			);
		}
		if (event === "thinking_delta") {
			return upsert(
				entries,
				`${phaseId}:thinking`,
				() => ({
					key: `${phaseId}:thinking`,
					phaseId,
					kind: "thinking",
					state: "active",
					text: data.text || "",
					startedAt: Date.now(),
					expanded: false,
				}),
				(entry) => ({ ...entry, text: (entry.text || "") + (data.text || "") }),
			);
		}
		if (event === "tool_start") {
			const key = `${phaseId}:tool:${data.name || "tool"}`;
			return upsert(
				entries,
				key,
				() => ({
					key,
					phaseId,
					kind: "tool",
					state: "active",
					name: data.name,
					arguments: data.arguments,
					text: data.name || "Tool",
					metrics: data.metrics,
					startedAt: Date.now(),
					expanded: false,
				}),
				(entry) => ({
					...entry,
					state: "active",
					arguments: data.arguments,
					metrics: data.metrics,
				}),
			);
		}
		if (event === "tool_complete") {
			const key = `${phaseId}:tool:${data.name || "tool"}`;
			/*
			 * Tool rows show their raw result inside the disclosure. Entity
			 * cards are not rendered here — they arrive with the answer, so a
			 * tool call stays a quiet one-line mechanism in the transcript.
			 */
			const presentation = {
				confirm: data.result?.confirmation_required ? data.result : undefined,
				// An artifact surfaces as a card on the row that produced it.
				artifact: data.result?.artifact,
			};
			return upsert(
				entries,
				key,
				() => ({
					key,
					phaseId,
					kind: "tool",
					state: "complete",
					name: data.name,
					result: data.result,
					text: data.name || "Tool",
					metrics: data.metrics,
					expanded: false,
					...presentation,
				}),
				(entry) => ({
					...entry,
					state: "complete",
					result: data.result,
					metrics: data.metrics,
					completedAt: Date.now(),
					...presentation,
				}),
			);
		}
		if (event === "answer_delta") {
			return upsert(
				entries,
				`${phaseId}:answer`,
				() => ({
					key: `${phaseId}:answer`,
					phaseId,
					kind: "answer",
					state: "active",
					text: String(data.text || "").replace(/<\/?think>/gi, ""),
					expanded: true,
				}),
				(entry) => ({
					...entry,
					text: `${entry.text || ""}${data.text || ""}`.replace(
						/<\/?think>/gi,
						"",
					),
				}),
			);
		}
		if (event === "answer") {
			// Cards ride with the reply; they are the answer's content.
			if (!Array.isArray(data.cards) || !data.cards.length) return entries;
			return upsert(
				entries,
				`${phaseId}:answer`,
				() => ({
					key: `${phaseId}:answer`,
					phaseId,
					kind: "answer",
					state: "active",
					text: "",
					items: data.cards,
					expanded: true,
				}),
				(entry) => ({ ...entry, items: data.cards }),
			);
		}
		if (event === "phase_metrics") {
			return entries.map((entry) =>
				entry.phaseId === phaseId
					? { ...entry, metrics: mergeMetrics(entry, data.metrics) }
					: entry,
			);
		}
		if (event === "phase_complete") {
			return entries
				.filter(
					(entry) =>
						!(
							entry.phaseId === phaseId &&
							(entry.kind === "thinking" || entry.kind === "answer") &&
							!String(entry.text || "").trim() &&
							// An answer whose content is cards has no text to prune on.
							!(entry.items && entry.items.length)
						),
				)
				.map((entry) =>
					entry.phaseId === phaseId
						? {
								...entry,
								text:
									entry.kind === "answer"
										? String(entry.text || "").trim()
										: entry.text,
								state: "complete",
								metrics: mergeMetrics(entry, data.metrics),
								completedAt: Date.now(),
							}
						: entry,
				);
		}
		return entries;
	}

	const api = { applyHarnessEvent, recentTraceLines };
	globalScope.RemindMeTimeline = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
