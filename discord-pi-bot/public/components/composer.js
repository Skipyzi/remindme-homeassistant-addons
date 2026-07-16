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
						messages: app.messages
							.filter((message) => message.text)
							.map((message) => ({
								role: message.type === "user" ? "user" : "assistant",
								content: message.text,
							})),
					}),
				});
				const usage = await response.json();
				app.tokenUsage = response.ok ? usage : { exact: false };
			} catch (_) {
				app.tokenUsage = { exact: false };
			}
		}, delay);
	}
	globalScope.RemindMeComposer = { measure };
})(window);
