import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Effort, PriorTurn, ToolSpec } from "../ai/types";
import type { ToolRun } from "../assistant/tools";
import { chatgptAuth } from "../subscriptions/chatgptAuth";
import { codexAccount } from "./native-accounts";
import { binary, JsonProcess, nativeEnvironment } from "./native-process";
import { agentDirectory } from "./paths";

/**
 * The CLI agents: Claude Code, Codex, OpenCode and Pi, each running a whole
 * turn itself with RemindMe's tools and nothing else. Ported from RemindMe
 * 3.1, where they ran as conversation backends.
 */
export const RUNNERS = ["claude-code", "codex", "opencode-cli", "pi"] as const;
export type RunnerId = (typeof RUNNERS)[number];

export const RUNNER_LABELS: Record<RunnerId, string> = {
	"claude-code": "Claude subscription",
	codex: "Codex",
	"opencode-cli": "OpenCode app",
	pi: "Pi",
};

export interface RunnerTurn {
	runner: RunnerId;
	model: string;
	/** Codex: its own CLI sign-in rather than the ChatGPT sign-in. */
	nativeAuth: boolean;
	system: string;
	prompt: string;
	history: PriorTurn[];
	effort: Effort;
	/** This conversation's session id in the CLI, so a turn resumes where the last one ended. */
	thread: { get(): string | undefined; set(id: string): void };
	tools: ToolSpec[];
	call(name: string, args: unknown): Promise<ToolRun>;
	/** The tool and inference bridge: a loopback URL and a token that lives for this turn. */
	bridge: { url: string; token: string };
	signal: AbortSignal;
	delta(text: string): void;
}

/** A resumed session already has the history; a fresh one is given it as context. */
export function runnerPrompt(turn: RunnerTurn): string {
	if (turn.thread.get() || !turn.history.length) return turn.prompt;
	const earlier = turn.history.map((entry) => `${entry.role}: ${entry.text}`).join("\n").slice(-24_000);
	return `Earlier in this conversation (context only; tool results are what actually happened):\n${earlier}\n\n${turn.prompt}`;
}

const bridgeEnvironment = (turn: RunnerTurn) => ({ REMINDME_TOOL_URL: turn.bridge.url, REMINDME_TOOL_TOKEN: turn.bridge.token });
const bridgeScript = () => join(__dirname, "mcp-stdio.js");
const mcpTool = (tool: ToolSpec) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters });

export async function runCodex(turn: RunnerTurn): Promise<void> {
	const options = await nativeEnvironment("codex");
	if (turn.nativeAuth) await codexAccount((worker) => worker.request("account/read", { refreshToken: true }));
	else await chatgptAuth.accessToken();
	options.env.ACCESS_TOKEN = turn.bridge.token;
	const config: Record<string, unknown> = {
		model_provider: "openai_chatgpt_plan",
		"model_providers.openai_chatgpt_plan.name": "ChatGPT plan",
		"model_providers.openai_chatgpt_plan.base_url": turn.bridge.url.replace("/agent-tools", "/agent-inference/v1"),
		"model_providers.openai_chatgpt_plan.env_key": "ACCESS_TOKEN",
		"model_providers.openai_chatgpt_plan.wire_api": "responses",
		"model_providers.openai_chatgpt_plan.requires_openai_auth": false,
		"model_providers.openai_chatgpt_plan.supports_websockets": false,
		"features.shell_tool": false, "features.unified_exec": false, "features.apply_patch_freeform": false,
		"features.multi_agent": false, "features.js_repl": false, web_search: "disabled",
		"features.code_mode_host": false, "features.code_mode": false, "features.tool_search": false,
		"features.apps": false, "features.browser_use": false, "features.computer_use": false, "features.goals": false,
	};
	let complete!: () => void;
	let fail!: (error: Error) => void;
	const terminal = new Promise<void>((resolve, reject) => {
		complete = resolve;
		fail = reject;
	});
	void terminal.catch(() => {});
	const worker = new JsonProcess(binary("codex"), ["app-server", "--listen", "stdio://", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])], { ...options, signal: turn.signal }, async (message) => {
		if (message.method === "item/tool/call" && message.id !== undefined) {
			try {
				const result = await turn.call(message.params.tool, message.params.arguments);
				worker.write({ id: message.id, result: { contentItems: [{ type: "inputText", text: result.content }], success: !result.isError } });
			} catch {
				worker.write({ id: message.id, result: { contentItems: [{ type: "inputText", text: "Tool capability ended" }], success: false } });
			}
		} else if (message.id !== undefined && message.method) {
			// No coding tools or permission escalation in a home assistant.
			worker.write({ id: message.id, error: { code: -32601, message: "Only the supplied Home Assistant tools are available" } });
		} else if (message.method === "item/agentMessage/delta") turn.delta(message.params.delta || "");
		else if (message.method === "turn/completed")
			message.params.turn.status === "completed" ? complete() : fail(new Error(message.params.turn.error?.message || `Codex turn ${message.params.turn.status}`));
	});
	try {
		await worker.request("initialize", { clientInfo: { name: "RemindMe Home Assistant", title: "RemindMe Home Assistant", version: "4.0.0" }, capabilities: { experimentalApi: true } });
		worker.write({ method: "initialized" });
		const previous = turn.thread.get();
		const thread = await worker.request(previous ? "thread/resume" : "thread/start", {
			...(previous ? { threadId: previous } : { dynamicTools: turn.tools.map((tool) => ({ type: "function", deferLoading: false, ...mcpTool(tool) })) }),
			model: turn.model,
			cwd: options.cwd,
			approvalPolicy: "never",
			sandbox: "read-only",
			baseInstructions: turn.system,
			developerInstructions: "Use only supplied home tools. Filesystem, terminal, coding, external MCP and delegation are disabled.",
			config,
		});
		const prompt = runnerPrompt(turn);
		turn.thread.set(thread.thread.id);
		await worker.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: prompt }], model: turn.model, effort: turn.effort });
		await Promise.race([terminal, worker.finished.then(() => { throw new Error("Codex ended without a completed turn"); })]);
	} finally {
		worker.stop();
		await worker.finished.catch(() => {});
	}
}

export async function runClaudeCode(turn: RunnerTurn): Promise<void> {
	const options = await nativeEnvironment("claude");
	const previous = turn.thread.get();
	const id = previous || randomUUID();
	const prompt = runnerPrompt(turn);
	const mcp = { mcpServers: { home: { command: process.execPath, args: [bridgeScript()], env: bridgeEnvironment(turn) } } };
	const args = ["-p", "--model", turn.model || "sonnet", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--allowedTools", "mcp__home__*", "--disable-slash-commands", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--permission-prompts", "none", "--system-prompt", turn.system, "--effort", turn.effort, previous ? "--resume" : "--session-id", id];
	let resultSeen = false;
	let resultError = "";
	let streamed = false;
	const worker = new JsonProcess(binary("claude"), args, { ...options, signal: turn.signal }, (message) => {
		if (message.type === "system" && message.subtype === "init") turn.thread.set(message.session_id || id);
		if (message.type === "stream_event" && message.event?.delta?.type === "text_delta") {
			streamed = true;
			turn.delta(message.event.delta.text);
		}
		if (message.type === "result") {
			resultSeen = true;
			if (message.is_error) resultError = message.errors?.join("; ") || "Claude turn failed";
			else if (!streamed && message.result) turn.delta(message.result);
		}
	});
	worker.child.stdin.end(prompt);
	await worker.finished;
	if (!resultSeen || resultError) throw new Error(resultError || "Claude ended without a completed result");
}

/** OpenCode's headless runner keeps its own session between turns, under its own sign-in. */
export async function runOpenCode(turn: RunnerTurn): Promise<void> {
	const options = await nativeEnvironment("opencode");
	const model = turn.model;
	if (!model.includes("/")) throw new Error("Choose one of the OpenCode app's models in RemindMe's AI settings.");
	const config = {
		$schema: "https://opencode.ai/config.json",
		autoupdate: false,
		share: "disabled",
		snapshot: false,
		plugin: [],
		enabled_providers: [model.split("/")[0]],
		permission: { "*": "deny", "home_*": "allow" },
		mcp: { home: { type: "local", command: [process.execPath, bridgeScript()], environment: bridgeEnvironment(turn), enabled: true } },
		agent: { home: { mode: "primary", description: "Home Assistant", prompt: turn.system, permission: { "*": "deny", "home_*": "allow" } } },
		default_agent: "home",
	};
	options.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
	options.env.OPENCODE_DISABLE_AUTOUPDATE = "true";
	options.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
	options.env.OPENCODE_DISABLE_CLAUDE_CODE = "true";
	const previous = turn.thread.get();
	let resultSeen = false;
	let error = "";
	const args = ["run", "--pure", "--format", "json", "--agent", "home", "--model", model, ...(previous ? ["--session", previous] : []), "--variant", turn.effort];
	const worker = new JsonProcess(binary("opencode"), args, { ...options, signal: turn.signal }, (message) => {
		if (message.sessionID && !turn.thread.get()) turn.thread.set(message.sessionID);
		if (message.type === "text") turn.delta(message.part?.text || "");
		if (message.type === "step_finish") resultSeen = true;
		if (message.type === "error") error = message.error?.data?.message || message.error?.message || "OpenCode turn failed";
	});
	worker.child.stdin.end(runnerPrompt(turn));
	await worker.finished;
	if (error || !resultSeen) throw new Error(error || "OpenCode ended without a completed result");
}

/** Dynamic import keeps Pi's ESM API usable from this CommonJS build. */
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;

export async function runPi(turn: RunnerTurn): Promise<void> {
	const sdk = await importEsm(pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
	const options = await nativeEnvironment("pi");
	const agentDir = join(agentDirectory(), "pi");
	const auth = sdk.AuthStorage.create(join(agentDir, "auth.json"));
	const registry = sdk.ModelRegistry.create(auth, join(agentDir, "models.json"));
	const separator = turn.model.indexOf("/");
	const model = separator > 0 ? registry.find(turn.model.slice(0, separator), turn.model.slice(separator + 1)) : undefined;
	if (!model || !auth.has(model.provider)) throw new Error("Sign in to this Pi provider and choose one of its models in RemindMe's AI settings.");
	const loader = new sdk.DefaultResourceLoader({ cwd: options.cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: turn.system });
	await loader.reload();
	const previous = turn.thread.get();
	const manager = previous ? sdk.SessionManager.open(previous, join(agentDir, "sessions"), options.cwd) : sdk.SessionManager.create(options.cwd, join(agentDir, "sessions"));
	const { session } = await sdk.createAgentSession({
		cwd: options.cwd,
		agentDir,
		authStorage: auth,
		modelRegistry: registry,
		model,
		thinkingLevel: turn.effort,
		tools: turn.tools.map((tool) => tool.name),
		resourceLoader: loader,
		sessionManager: manager,
		settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }),
		customTools: turn.tools.map((tool) => ({
			name: tool.name,
			label: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_id: string, args: unknown) => ({ content: [{ type: "text", text: (await turn.call(tool.name, args)).content }], details: {} }),
		})),
	});
	const prompt = runnerPrompt(turn);
	turn.thread.set(manager.getSessionFile());
	let failure = "";
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") turn.delta(event.assistantMessageEvent.delta);
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") failure = event.message.errorMessage || "Pi turn failed";
	});
	const cancel = () => {
		void session.abort();
	};
	turn.signal.addEventListener("abort", cancel, { once: true });
	try {
		turn.signal.throwIfAborted();
		await session.prompt(prompt);
		turn.signal.throwIfAborted();
		if (failure) throw new Error(failure);
	} finally {
		unsubscribe();
		turn.signal.removeEventListener("abort", cancel);
		session.dispose();
	}
}

export const RUN: Record<RunnerId, (turn: RunnerTurn) => Promise<void>> = {
	"claude-code": runClaudeCode,
	codex: runCodex,
	"opencode-cli": runOpenCode,
	pi: runPi,
};
