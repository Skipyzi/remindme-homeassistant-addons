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
			name: "/vault",
			usage: "/vault [query]",
			blurb: "browse memory notes, no model turn",
			async run(app, argument) {
				const url = argument
					? `./api/vault?search=${encodeURIComponent(argument)}`
					: "./api/vault";
				const response = await fetch(url);
				const notes = response.ok ? await response.json() : [];
				if (!notes.length)
					return app.add(
						"answer",
						argument ? `No notes match \`${argument}\`.` : "The vault is empty.",
					);
				app.add(
					"answer",
					[
						`${notes.length} note${notes.length > 1 ? "s" : ""}${argument ? ` matching \`${argument}\`` : ""}:`,
						...notes.map((note) => {
							const tags = note.tags?.length
								? ` — ${note.tags.map((tag) => `#${tag}`).join(" ")}`
								: "";
							return `- **${note.title}** \`${note.path}\`${tags}`;
						}),
					].join("\n"),
				);
			},
		},
		{
			name: "/memory",
			usage: "/memory [query | forget <path>]",
			blurb: "what the model remembers — insight & edit",
			async run(app, argument) {
				const say = (text) => app.add("answer", text);
				const trimmed = (argument || "").trim();
				const [word, ...rest] = trimmed.split(/\s+/);
				const sub = word?.toLowerCase();

				// Forget: drop one memory. Editing a memory is done in the vault —
				// every row below carries an "edit ↗" deep-link when configured.
				if (sub === "forget" || sub === "delete") {
					const path = rest.join(" ").trim();
					if (!path)
						return say("Usage: `/memory forget <path>` — the path shown in `/memory`.");
					const response = await fetch(
						`./api/vault/note?path=${encodeURIComponent(path)}`,
						{ method: "DELETE" },
					);
					return say(response.ok ? `Forgotten \`${path}\`.` : `No memory at \`${path}\`.`);
				}

				const search = trimmed;
				const url = search
					? `./api/vault?search=${encodeURIComponent(search)}`
					: "./api/vault";
				const response = await fetch(url);
				const notes = response.ok ? await response.json() : [];
				if (!notes.length)
					return say(
						search
							? `No memories match \`${search}\`.`
							: "No memories yet. They build up as you work — or tell me something worked and I'll keep it.",
					);

				// Memories are vault notes; group them by the kind write_memory sets.
				const ORDER = ["user", "feedback", "project", "reference"];
				const LABEL = {
					user: "About you",
					feedback: "How to work",
					project: "Projects",
					reference: "References",
					other: "Other",
				};
				const byType = new Map();
				for (const note of notes) {
					const key = ORDER.includes(note.type) ? note.type : "other";
					if (!byType.has(key)) byType.set(key, []);
					byType.get(key).push(note);
				}
				const row = (note) => {
					const tags = note.tags?.length
						? ` — ${note.tags.map((tag) => `#${tag}`).join(" ")}`
						: "";
					const editUrl = app.vaultNoteUrl?.(note.path);
					const edit = editUrl ? ` · [edit ↗](${editUrl})` : "";
					return `- **${note.title}** \`${note.path}\`${tags}${edit}`;
				};
				const sections = [...ORDER, "other"]
					.filter((key) => byType.has(key))
					.map((key) =>
						[
							`**${LABEL[key]}** (${byType.get(key).length})`,
							...byType.get(key).map(row),
						].join("\n"),
					);
				const plural = notes.length > 1 ? "memories" : "memory";
				say(
					[
						search
							? `${notes.length} ${plural} matching \`${search}\`:`
							: `${notes.length} ${plural} held:`,
						"",
						...sections.map((section) => `${section}\n`),
						"`/memory forget <path>` to drop one · edit any in the vault.",
					].join("\n"),
				);
			},
		},
		{
			name: "/graph",
			usage: "/graph [query]",
			blurb: "the vault drawn as a constellation",
			async run(app, argument) {
				await app.openVaultGraph(argument);
			},
		},
		{
			name: "/task",
			usage: "/task [new | <when> <what> | list | run <id> | on/off <id> | delete <id>]",
			blurb: "scheduled reports and research runs",
			async run(app, argument) {
				const say = (text) => app.add("answer", text);
				const fetchTasks = async () => {
					const response = await fetch("./api/tasks");
					return response.ok ? await response.json() : [];
				};
				// Resolve a short id (as listed) to a full task.
				const resolve = async (prefix) => {
					const list = await fetchTasks();
					return list.find((task) => task.id.startsWith(prefix));
				};
				const nextLabel = (task) =>
					task.enabled
						? new Date(task.nextRun).toLocaleString()
						: "paused";

				const trimmed = (argument || "").trim();
				const [word, ...rest] = trimmed.split(/\s+/);
				const sub = word?.toLowerCase();
				const target = rest.join(" ").trim();

				// The wizard is the friendly path in: an inline form, no grammar
				// to remember. Opened explicitly, or when there is nothing to list.
				if (sub === "new" || sub === "wizard") {
					app.openTaskWizard();
					return;
				}
				if (!trimmed || sub === "list") {
					const list = await fetchTasks();
					if (!list.length) {
						app.openTaskWizard();
						return;
					}
					return say(
						[
							`${list.length} task${list.length > 1 ? "s" : ""}:`,
							...list.map(
								(task) =>
									`- \`${task.id.slice(0, 8)}\` **${task.name}** — ${task.scheduleText} · next ${nextLabel(task)}${task.enabled ? "" : " *(off)*"}`,
							),
							"",
							"`/task new` for the wizard · `/task run <id>` to run now · `/task off <id>` to pause · `/task delete <id>` to remove.",
						].join("\n"),
					);
				}

				if (["delete", "remove", "rm"].includes(sub)) {
					const task = await resolve(target);
					if (!task) return say(`No task starting \`${target}\`.`);
					await fetch(`./api/tasks/${encodeURIComponent(task.id)}`, {
						method: "DELETE",
					});
					return say(`Deleted **${task.name}**.`);
				}
				if (["on", "off", "enable", "disable"].includes(sub)) {
					const task = await resolve(target);
					if (!task) return say(`No task starting \`${target}\`.`);
					const enabled = sub === "on" || sub === "enable";
					await fetch(`./api/tasks/${encodeURIComponent(task.id)}`, {
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ enabled }),
					});
					return say(`**${task.name}** ${enabled ? "resumed" : "paused"}.`);
				}
				if (sub === "run") {
					const task = await resolve(target);
					if (!task) return say(`No task starting \`${target}\`.`);
					say(`Running **${task.name}** now…`);
					const response = await fetch(
						`./api/tasks/${encodeURIComponent(task.id)}/run`,
						{ method: "POST" },
					);
					const outcome = response.ok ? await response.json() : { status: "error", summary: "Request failed" };
					return say(
						outcome.status === "ok"
							? `**${task.name}** done: ${outcome.summary}${outcome.notePath ? ` — saved to \`${outcome.notePath}\`` : ""}`
							: `**${task.name}** failed: ${outcome.summary}`,
					);
				}

				// Anything else is a new task: "<when> <what>".
				const response = await fetch("./api/tasks", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ text: trimmed }),
				});
				if (!response.ok) {
					const error = await response.json().catch(() => ({}));
					return say(error.error || "Could not create the task.");
				}
				const task = await response.json();
				return say(
					`Scheduled **${task.name}** — ${task.scheduleText}. First run ${nextLabel(task)}.`,
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
