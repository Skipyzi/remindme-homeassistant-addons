(function exposeComposer(globalScope) {
	let timer;
	function measure(app, delay = 220) {
		clearTimeout(timer);
		timer = setTimeout(async () => {
			try {
				const response = await fetch("./api/tokenize", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						prompt: app.draft,
						messages: app.modelHistory(),
					}),
				});
				const usage = await response.json();
				app.tokenUsage = response.ok ? usage : { exact: false };
			} catch (_) {
				app.tokenUsage = { exact: false };
			}
		}, delay);
	}
	function handleKeydown(app, event) {
		if (event.key !== "Enter" || event.isComposing) return "ignored";
		if (event.ctrlKey) {
			event.preventDefault();
			const target = event.target;
			const start = Number.isInteger(target?.selectionStart)
				? target.selectionStart
				: app.draft.length;
			const end = Number.isInteger(target?.selectionEnd)
				? target.selectionEnd
				: start;
			app.draft = `${app.draft.slice(0, start)}\n${app.draft.slice(end)}`;
			app.$nextTick(() => {
				target?.setSelectionRange?.(start + 1, start + 1);
				app.resizeComposer({ target });
			});
			return "newline";
		}
		if (!event.shiftKey && !event.altKey && !event.metaKey) {
			event.preventDefault();
			void app.send();
			return "send";
		}
		return "ignored";
	}
	const api = { measure, handleKeydown };
	globalScope.RemindMeComposer = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
