(function exposeChatHistory(globalScope) {
	const deviceActions = new Set(["home_control", "home_lighting", "home_status", "home_assistant"]);
	const receiptKeys = ["done", "problems", "settings", "command", "value", "awaiting_confirmation", "entities", "kind", "speech", "handled_by", "error"];
	function fromMessages(messages) {
		const turns = [];
		let sources = "";
		let receipts = [];
		for (const message of messages) {
			if (message.kind === "user" && message.text?.trim()) {
				turns.push({ role: "user", content: message.text });
				sources = "";
				receipts = [];
			} else if (message.kind === "tool" && message.name === "web_search") {
				const results = message.result?.results;
				if (Array.isArray(results)) {
					const list = results.slice(0, 6).filter((result) => result?.url).map((result, index) => `${index + 1}. ${result.title || result.url} — ${result.url}`).join("\n");
					if (list) sources = `\n\n[Web search sources:\n${list}]`;
				}
			} else if (message.kind === "tool" && deviceActions.has(message.name) && message.state === "complete" && message.result && typeof message.result === "object") {
				const result = Array.isArray(message.result) ? message.result.slice(0, 8) : Object.fromEntries(receiptKeys.filter((key) => key in message.result).map((key) => [key, message.result[key]]));
				receipts.push(JSON.stringify({ action: message.name, arguments: message.arguments, result }).slice(0, 3000));
			} else if (message.kind === "answer" && message.text?.trim()) {
				const evidence = receipts.length ? `[App action receipts:\n${receipts.slice(-8).join("\n")}]` : "[No app device-action receipt for this reply.]";
				turns.push({ role: "assistant", content: `${message.text}${sources}\n\n${evidence}` });
				sources = "";
				receipts = [];
			}
		}
		return turns;
	}
	const api = { fromMessages };
	globalScope.RemindMeChatHistory = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
