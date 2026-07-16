(function exposeThinking(globalScope) {
	function formatThought(entry) {
		const durationMs = Math.max(
			0,
			(entry.completedAt || Date.now()) - (entry.startedAt || Date.now()),
		);
		const duration =
			durationMs >= 60_000
				? `${(durationMs / 60_000).toFixed(1)} minutes`
				: `${(durationMs / 1_000).toFixed(1)} seconds`;
		const speed = entry.metrics?.decodeTokensPerSecond;
		return `Thought for ${duration}${speed ? ` · ${speed.toFixed(1)} tok/s` : ""}`;
	}
	globalScope.RemindMeThinking = { formatThought };
})(window);
