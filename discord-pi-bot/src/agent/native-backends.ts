import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chatgptAuth } from "../harness/chatgptAuth";
import type { ResolvedEndpoint } from "../harness/endpoints";
import type { ThinkingMode } from "../harness/thinkingProfiles";
import { usesResponses } from "../harness/responses";
import { binary, JsonProcess, nativeEnvironment } from "./native-process";
import { agentDirectory, type AgentBackend, type AgentSession } from "./runtime-store";
import type { AgentTool } from "./tool-gateway";

export interface NativeTurn {
	backend: AgentBackend; model: string; prompt: string; system: string; effort: ThinkingMode;
	session: AgentSession; save(): void; signal: AbortSignal; endpoint: ResolvedEndpoint;
	tools: AgentTool[]; call(name: string, args: unknown): Promise<unknown>;
	bridge: { url: string; token: string }; delta(text: string): void;
}
export function nativePrompt(turn: NativeTurn): string {
	return turn.session.threads[turn.backend] ? turn.prompt : `${turn.session.history.length ? `Previous conversation (context only; tool receipts are authoritative):\n${turn.session.history.map(message => `${message.role}: ${message.content}`).join("\n").slice(-24000)}\n\n` : ""}${turn.prompt}`;
}

export async function runCodex(turn: NativeTurn) {
	const options = await nativeEnvironment("codex");
	await chatgptAuth.accessToken();
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
		"features.multi_agent": false, "features.js_repl": false, "web_search": "disabled",
		"features.code_mode_host": false, "features.code_mode": false, "features.tool_search": false,
		"features.apps": false, "features.browser_use": false, "features.computer_use": false, "features.goals": false,
	};
	let complete!: () => void;
	let fail!: (error: Error) => void;
	const terminal = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
	void terminal.catch(() => {});
	const worker = new JsonProcess(binary("codex"), ["app-server", "--listen", "stdio://", ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`])], { ...options, signal: turn.signal }, async message => {
		if (message.method === "item/tool/call" && message.id !== undefined) {
			try {
				const result = await turn.call(message.params.tool, message.params.arguments);
				worker.write({ id: message.id, result: { contentItems: [{ type: "inputText", text: JSON.stringify(result) }], success: !(result as any)?.error } });
			} catch { worker.write({ id: message.id, result: { contentItems: [{ type: "inputText", text: "Tool capability ended" }], success: false } }); }
		} else if (message.id !== undefined && message.method) {
			// No coding tools or runtime permission escalation in a home assistant.
			worker.write({ id: message.id, error: { code: -32601, message: "Only the supplied Home Assistant tools are available" } });
		} else if (message.method === "item/agentMessage/delta") turn.delta(message.params.delta || "");
		else if (message.method === "turn/completed") message.params.turn.status === "completed" ? complete() : fail(new Error(message.params.turn.error?.message || `Codex turn ${message.params.turn.status}`));
	});
	try {
		await worker.request("initialize", { clientInfo: { name: "RemindMe Home Assistant", title: "RemindMe Home Assistant", version: "3.1.0" }, capabilities: { experimentalApi: true } });
		worker.write({ method: "initialized" });
		const previous = turn.session.threads.codex;
		const thread = await worker.request(previous ? "thread/resume" : "thread/start", { ...(previous ? { threadId: previous } : { dynamicTools: turn.tools.map(tool => ({ type: "function", deferLoading: false, ...tool })) }), model: turn.model, cwd: options.cwd, approvalPolicy: "never", sandbox: "read-only", baseInstructions: turn.system, developerInstructions: "Use only supplied home tools. Filesystem, terminal, coding, external MCP and delegation are disabled.", config });
		const prompt = nativePrompt(turn);
		turn.session.threads.codex = thread.thread.id;
		turn.save();
		await worker.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: prompt }], model: turn.model, effort: turn.effort === "none" ? "none" : turn.effort });
		await Promise.race([terminal, worker.finished.then(() => { throw new Error("Codex ended without a completed turn"); })]);
	} finally { worker.stop(); await worker.finished.catch(() => {}); }
}

const bridgeEnvironment = (turn: NativeTurn) => ({ REMINDME_TOOL_URL: turn.bridge.url, REMINDME_TOOL_TOKEN: turn.bridge.token });
const bridgeScript = () => join(__dirname, "mcp-stdio.js");

export async function runClaude(turn: NativeTurn) {
	const options = await nativeEnvironment("claude");
	const previous = turn.session.threads.claude;
	const id = previous || randomUUID();
	const prompt = nativePrompt(turn);
	const mcp = { mcpServers: { home: { command: process.execPath, args: [bridgeScript()], env: bridgeEnvironment(turn) } } };
	const args = ["-p", "--model", turn.model || "sonnet", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify(mcp), "--allowedTools", "mcp__home__*", "--disable-slash-commands", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--permission-prompts", "none", "--system-prompt", turn.system, "--effort", turn.effort === "none" ? "low" : turn.effort, previous ? "--resume" : "--session-id", id];
	let resultSeen = false;
	let resultError = "";
	let streamed = false;
	const worker = new JsonProcess(binary("claude"), args, { ...options, signal: turn.signal }, message => {
		if (message.type === "system" && message.subtype === "init") { turn.session.threads.claude = message.session_id || id; turn.save(); }
		if (message.type === "stream_event" && message.event?.delta?.type === "text_delta") { streamed = true; turn.delta(message.event.delta.text); }
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

/** OpenCode's headless runner retains its native SQLite session between turns. */
export async function runOpenCode(turn: NativeTurn) {
	if (turn.endpoint.authProvider === "claude") throw new Error("Choose an API or local/network endpoint for OpenCode, or use the Claude backend.");
	const options = await nativeEnvironment("opencode");
	const token = turn.bridge.token;
	const baseURL = turn.bridge.url.replace("/agent-tools", "/agent-inference/v1");
	const model = turn.model || turn.endpoint.model;
	if (!model) throw new Error("Choose an endpoint model for OpenCode.");
	const config = {
		$schema: "https://opencode.ai/config.json", autoupdate: false, share: "disabled", snapshot: false, plugin: [], enabled_providers: ["remindme"],
		provider: { remindme: { npm: usesResponses(turn.endpoint.url) ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible", name: "RemindMe endpoint", options: { baseURL, apiKey: token }, models: { [model]: { name: model } } } },
		permission: { "*": "deny", "home_*": "allow" },
		mcp: { home: { type: "local", command: [process.execPath, bridgeScript()], environment: bridgeEnvironment(turn), enabled: true } },
		agent: { home: { mode: "primary", description: "Home Assistant", prompt: turn.system, permission: { "*": "deny", "home_*": "allow" } } }, default_agent: "home",
	};
	options.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
	options.env.OPENCODE_DISABLE_AUTOUPDATE = "true";
	options.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
	options.env.OPENCODE_DISABLE_CLAUDE_CODE = "true";
	const previous = turn.session.threads.opencode;
	let resultSeen = false;
	let error = "";
	const args = ["run", "--pure", "--format", "json", "--agent", "home", "--model", `remindme/${model}`, ...(previous ? ["--session", previous] : []), ...(turn.effort === "none" ? [] : ["--variant", turn.effort])];
	const worker = new JsonProcess(binary("opencode"), args, { ...options, signal: turn.signal }, message => {
		if (message.sessionID && !turn.session.threads.opencode) { turn.session.threads.opencode = message.sessionID; turn.save(); }
		if (message.type === "text") turn.delta(message.part?.text || "");
		if (message.type === "step_finish") resultSeen = true;
		if (message.type === "error") error = message.error?.data?.message || message.error?.message || "OpenCode turn failed";
	});
	worker.child.stdin.end(nativePrompt(turn));
	await worker.finished;
	if (error || !resultSeen) throw new Error(error || "OpenCode ended without a completed result");
}

/** Dynamic import preserves Pi's ESM API when this add-on builds as CommonJS. */
const importEsm = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<any>;
export async function runPi(turn: NativeTurn) {
	if (turn.endpoint.authProvider === "claude") throw new Error("Choose an API or local/network endpoint for Pi, or use the Claude backend.");
	const sdk = await importEsm(pathToFileURL(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/index.js")).href);
	const options = await nativeEnvironment("pi");
	const agentDir = join(agentDirectory(), "pi");
	const auth = sdk.AuthStorage.create(join(agentDir, "auth.json"));
	const registry = sdk.ModelRegistry.create(auth, join(agentDir, "models.json"));
	const token = turn.bridge.token;
	const modelId = turn.model || turn.endpoint.model;
	if (!modelId) throw new Error("Choose an endpoint model for Pi.");
	registry.registerProvider("remindme", {
		baseUrl: turn.bridge.url.replace("/agent-tools", "/agent-inference/v1"), api: usesResponses(turn.endpoint.url) ? "openai-responses" : "openai-completions", apiKey: token,
		models: [{ id: modelId, name: modelId, reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 4096 }],
	});
	const model = registry.find("remindme", modelId);
	const loader = new sdk.DefaultResourceLoader({ cwd: options.cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: turn.system });
	await loader.reload();
	const previous = turn.session.threads.pi;
	const manager = previous ? sdk.SessionManager.open(previous, join(agentDir, "sessions"), options.cwd) : sdk.SessionManager.create(options.cwd, join(agentDir, "sessions"));
	const { session } = await sdk.createAgentSession({ cwd: options.cwd, agentDir, authStorage: auth, modelRegistry: registry, model, thinkingLevel: turn.effort === "none" ? "off" : turn.effort, tools: turn.tools.map(tool => tool.name), resourceLoader: loader, sessionManager: manager, settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } }), customTools: turn.tools.map(tool => ({ name: tool.name, label: tool.name, description: tool.description, parameters: tool.inputSchema, execute: async (_id: string, args: unknown) => ({ content: [{ type: "text", text: JSON.stringify(await turn.call(tool.name, args)) }], details: {} }) })) });
	const prompt = nativePrompt(turn);
	turn.session.threads.pi = manager.getSessionFile();
	turn.save();
	let failure = "";
	const unsubscribe = session.subscribe((event: any) => {
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") turn.delta(event.assistantMessageEvent.delta);
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") failure = event.message.errorMessage || "Pi turn failed";
	});
	const cancel = () => { void session.abort(); };
	turn.signal.addEventListener("abort", cancel, { once: true });
	try { turn.signal.throwIfAborted(); await session.prompt(prompt); turn.signal.throwIfAborted(); if (failure) throw new Error(failure); }
	finally { unsubscribe(); turn.signal.removeEventListener("abort", cancel); session.dispose(); }
}
