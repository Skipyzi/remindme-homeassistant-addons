(function exposeCommands(globalScope) {
	/**
	 * Local commands: answered by the console itself, never sent to the model.
	 *
	 * On a Pi a round trip costs seconds and hundreds of tokens against a small
	 * context window, so anything the console already knows — its tools, its
	 * skills, what a light is doing — should not require an inference pass to
	 * find out.
	 */

	const table = (rows) =>
		rows.map(([name, blurb]) => `  ${name.padEnd(22)}${blurb}`).join("\n");

	const COMMANDS = [
		{
			name: "/help",
			usage: "/help",
			blurb: "this list",
			async run(app) {
				app.add(
					"answer",
					[
						"Local commands — answered here, no tokens spent:",
						table(COMMANDS.map((c) => [c.usage, c.blurb])),
					].join("\n"),
				);
			},
		},
		{
			name: "/tools",
			usage: "/tools",
			blurb: "tools the model can call",
			async run(app) {
				const response = await fetch("./api/tools");
				const tools = response.ok ? await response.json() : [];
				if (!tools.length) return app.add("answer", "No tools available.");
				app.add(
					"answer",
					[
						`${tools.length} tools available:`,
						"",
						...tools.map((tool) =>
							[
								`**${tool.name}**(${(tool.parameters || []).join(", ")})`,
								`  ${tool.description || ""}`,
							].join("\n"),
						),
					].join("\n"),
				);
			},
		},
		{
			name: "/entities",
			usage: "/entities <query>",
			blurb: "look up devices, no model turn",
			async run(app, argument) {
				if (!argument)
					return app.add("answer", "Usage: `/entities kitchen light`");
				const response = await fetch(
					`./api/entities?query=${encodeURIComponent(argument)}`,
				);
				if (!response.ok)
					return app.add("answer", "Home Assistant is unavailable.");
				const cards = await response.json();
				if (!cards.length)
					return app.add("answer", `Nothing matched \`${argument}\`.`);
				// Rendered as cards, exactly as a tool result would be.
				app.add("answer", `${cards.length} match${cards.length > 1 ? "es" : ""}:`, {
					kind: "answer",
					items: cards,
				});
			},
		},
		{
			name: "/artifact",
			usage: "/artifact [title]",
			blurb: "turn the last code block into one",
			async run(app, argument) {
				// Search backwards: the most recent fenced block is what "that"
				// almost always means.
				const fence = new RegExp("```([\\w+-]*)\\n([\\s\\S]*?)```", "g");
				let found;
				for (let i = app.messages.length - 1; i >= 0 && !found; i -= 1) {
					const text = app.messages[i].text || "";
					let match;
					fence.lastIndex = 0;
					while ((match = fence.exec(text))) found = match;
				}
				if (!found)
					return app.add(
						"answer",
						"No code block found in this conversation to make an artifact from.",
					);
				const language = (found[1] || "").toLowerCase();
				const content = found[2];
				/*
				 * A fenced block's language names what it is, so a ```glsl block
				 * becomes a runnable shader rather than a wall of highlighted
				 * text. Anything not runnable stays `code`.
				 */
				const KINDS = {
					html: "html",
					htm: "html",
					xhtml: "html",
					svg: "svg",
					markdown: "markdown",
					md: "markdown",
					glsl: "glsl",
					frag: "glsl",
					shader: "glsl",
					wgsl: "wgsl",
					lua: "lua",
					three: "three",
					threejs: "three",
				};
				const kind = KINDS[language] || "code";
				const response = await fetch("./api/artifacts", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						title: argument || `${language || "code"} snippet`,
						kind,
						language,
						content,
					}),
				});
				if (!response.ok)
					return app.add("answer", "Could not create the artifact.");
				const artifact = await response.json();
				app.add("answer", `Made an artifact from the last ${language || "code"} block.`, {
					kind: "answer",
					artifact,
				});
				await app.openArtifact(artifact.id);
			},
		},
		{
			name: "/reminders",
			usage: "/reminders",
			blurb: "what is scheduled",
			async run(app) {
				const response = await fetch("./api/reminders");
				const reminders = response.ok ? await response.json() : [];
				if (!reminders.length) return app.add("answer", "No reminders set.");
				app.add(
					"answer",
					[
						`${reminders.length} reminder(s):`,
						...reminders.map(
							(item) => `- ${item.message} — ${new Date(item.time).toLocaleString()}`,
						),
					].join("\n"),
				);
			},
		},
		{
			name: "/skills",
			usage: "/skills",
			blurb: "which skills are shaping replies",
			async run(app) {
				const response = await fetch("./api/skills");
				const skills = response.ok ? await response.json() : [];
				const on = skills.filter((skill) => skill.enabled);
				app.add(
					"answer",
					[
						`${on.length} of ${skills.length} skills enabled.`,
						...skills.map(
							(skill) => `- ${skill.enabled ? "**on**" : "off"} — ${skill.name}`,
						),
						"",
						"Manage them in the Skills panel.",
					].join("\n"),
				);
			},
		},
		{
			name: "/context",
			usage: "/context",
			blurb: "token and context usage",
			async run(app) {
				const usage = app.tokenUsage || {};
				const metrics = app.metrics || {};
				app.add(
					"answer",
					[
						"Context:",
						`- window: ${usage.contextCapacity || "?"} tokens`,
						`- conversation: ${usage.contextTokens ?? "?"}${usage.exact ? "" : " (estimated)"}`,
						`- last prompt: ${metrics.inputTokens ?? "?"} in`,
						`- last reply: ${metrics.thinking ?? 0} thinking tokens`,
						`- messages held: ${app.messages.length}`,
					].join("\n"),
				);
			},
		},
		{
			name: "/diagnose",
			usage: "/diagnose",
			blurb: "probe the model manager",
			async run(app) {
				const response = await fetch("./api/models/diagnostics");
				const report = await response.json();
				app.add(
					"answer",
					[
						`Model manager: ${report.ok ? "healthy" : "**not healthy**"}`,
						"",
						...(report.checks || []).map((check) =>
							[
								`- ${check.ok ? "pass" : "**fail**"} — ${check.step}: ${check.detail || ""}`,
								check.hint ? `    ${check.hint}` : "",
							]
								.filter(Boolean)
								.join("\n"),
						),
					].join("\n"),
				);
			},
		},
		{
			name: "/new",
			usage: "/new",
			blurb: "start a fresh conversation",
			async run(app) {
				await app.newChat();
			},
		},
		{
			name: "/clear",
			usage: "/clear",
			blurb: "empty this transcript",
			async run(app) {
				app.clearChat();
			},
		},
	];

	function find(name) {
		return COMMANDS.find((command) => command.name === name);
	}

	/** Returns true when the input was handled locally. */
	async function run(app, text) {
		const trimmed = String(text || "").trim();
		if (!trimmed.startsWith("/")) return false;
		const [word, ...rest] = trimmed.split(/\s+/);
		const command = find(word.toLowerCase());
		if (!command) return false;
		app.add("user", trimmed);
		try {
			await command.run(app, rest.join(" ").trim());
		} catch (error) {
			app.add("answer", `\`${word}\` failed: ${error.message || error}`);
		}
		return true;
	}

	/**
	 * The remainder of the command being typed, or "" when there is nothing to
	 * suggest. Only completes the command word itself: once you are typing
	 * arguments the console has nothing useful to guess.
	 */
	function ghost(draft) {
		const value = String(draft || "");
		if (!value.startsWith("/") || /\s/.test(value)) return "";
		const matches = COMMANDS.filter((command) =>
			command.name.startsWith(value.toLowerCase()),
		);
		// Ambiguous prefixes complete only as far as every match agrees, the
		// way a shell does, so a keystroke never commits you to the wrong one.
		if (!matches.length) return "";
		if (matches.length === 1) return matches[0].name.slice(value.length);
		let shared = matches[0].name;
		for (const match of matches.slice(1)) {
			let index = 0;
			while (
				index < shared.length &&
				index < match.name.length &&
				shared[index] === match.name[index]
			)
				index += 1;
			shared = shared.slice(0, index);
		}
		return shared.length > value.length ? shared.slice(value.length) : "";
	}

	/** Commands matching what has been typed, for the hint strip. */
	function matching(draft) {
		const value = String(draft || "").toLowerCase();
		if (!value.startsWith("/")) return [];
		const word = value.split(/\s/)[0];
		return COMMANDS.filter((command) => command.name.startsWith(word));
	}

	/** Names for the composer's hint, so the set is discoverable. */
	function names() {
		return COMMANDS.map((command) => command.usage);
	}

	const api = { run, names, ghost, matching, COMMANDS };
	globalScope.RemindMeCommands = api;
	if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
