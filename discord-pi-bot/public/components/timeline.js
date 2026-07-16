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
			const presentation = {
				items: Array.isArray(data.result) ? data.result : undefined,
				confirm: data.result?.confirmation_required ? data.result : undefined,
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
					text: data.text || "",
					expanded: true,
				}),
				(entry) => ({ ...entry, text: (entry.text || "") + (data.text || "") }),
			);
		}
		if (event === "phase_metrics") {
			return entries.map((entry) =>
				entry.phaseId === phaseId ? { ...entry, metrics: data.metrics } : entry,
			);
		}
		if (event === "phase_complete") {
			return entries
				.filter(
					(entry) =>
						!(
							entry.phaseId === phaseId &&
							entry.kind === "thinking" &&
							!String(entry.text || "").trim()
						),
				)
				.map((entry) =>
					entry.phaseId === phaseId
						? {
								...entry,
								state: "complete",
								metrics: data.metrics || entry.metrics,
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
