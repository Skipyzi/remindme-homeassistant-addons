import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Express } from "express";
import { agentDirectory } from "./runtime-store";
import { binary, nativeEnvironment, JsonProcess } from "./native-process";
import { claudeAuth } from "../harness/claudeAuth";

type ModelChoice = { id: string; name: string; provider?: string };
const piScript = () => join(__dirname, "pi-accounts.js");
async function json(path: string): Promise<Record<string, any>> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as any).code === "ENOENT") return {}; throw new Error("The CLI credential store could not be read"); } }
export const quoteCommand = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

async function output(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "ignore"] });
		let data = "";
		child.stdout.on("data", chunk => { data += chunk; if (data.length > 4_000_000) child.kill(); });
		const timer = setTimeout(() => child.kill(), 20_000);
		child.once("error", () => { clearTimeout(timer); reject(new Error("The CLI could not start")); });
		child.once("close", code => { clearTimeout(timer); code === 0 ? resolve(data) : reject(new Error("The CLI catalog could not be loaded")); });
	});
}

export async function codexAccount<T>(read: (worker: JsonProcess) => Promise<T>): Promise<T> {
	const worker = new JsonProcess(binary("codex"), ["app-server", "--listen", "stdio://"], { ...await nativeEnvironment("codex"), signal: AbortSignal.timeout(20_000) }, () => {});
	try {
		await worker.request("initialize", { clientInfo: { name: "RemindMe Home Assistant", title: "RemindMe Home Assistant", version: "3.1.1" } });
		worker.write({ method: "initialized" });
		return await read(worker);
	} finally { worker.stop(); await worker.finished.catch(() => {}); }
}

export async function nativeCodexFetch(body: Record<string, any>, signal?: AbortSignal) {
	const auth = await json(join(agentDirectory(), "codex/auth.json"));
	const token = auth.tokens?.access_token;
	if (typeof token !== "string" || !token) throw new Error("Sign in to Codex in the account console first.");
	const request: Record<string, any> = { ...body, instructions: body.instructions || "", stream: true, store: false };
	for (const key of ["max_output_tokens", "temperature", "top_p", "previous_response_id", "truncation"]) delete request[key];
	return fetch("https://chatgpt.com/backend-api/codex/responses", { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(auth.tokens.account_id ? { "ChatGPT-Account-Id": auth.tokens.account_id } : {}), "OpenAI-Beta": "responses=experimental", originator: "RemindMe Home Assistant" }, body: JSON.stringify(request), signal });
}

interface Login {
	id: string; backend: string; output: string; running: boolean; child?: ChildProcessWithoutNullStreams;
	timer?: ReturnType<typeof setTimeout>; prompt?: string; options?: Array<{ id: string; label: string }>; urls: string[];
}
export class NativeAccounts {
	private login?: Login;
	private cache = new Map<string, { at: number; data: any }>();
	async catalog(backend: string) {
		const cached = this.cache.get(backend);
		if (cached && Date.now() - cached.at < 30_000) return cached.data;
		const options = await nativeEnvironment(backend);
		let data: { connected: string[]; models: ModelChoice[]; providers?: Array<{ id: string; name: string }> };
		if (backend === "codex") {
			const auth = await json(join(agentDirectory(), "codex/auth.json"));
			data = { connected: auth.tokens?.access_token ? ["ChatGPT"] : [], models: [] };
			if (data.connected.length) data.models = await codexAccount(async worker => {
				await worker.request("account/read", { refreshToken: true });
				const list = await worker.request("model/list", { limit: 100 });
				return list.data.filter((m: any) => !m.hidden).map((m: any) => ({ id: m.model || m.id, name: m.displayName || m.model || m.id, provider: "ChatGPT" }));
			});
		} else if (backend === "opencode") {
			const auth = await json(join(options.env.XDG_DATA_HOME!, "opencode/auth.json"));
			const connected = Object.keys(auth);
			options.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
			const catalog = connected.length ? await output(binary("opencode"), ["models"], options) : "";
			data = { connected, models: catalog.split(/\r?\n/).filter(id => connected.includes(id.split("/")[0]!)).map(id => ({ id, name: id.split("/").slice(1).join("/"), provider: id.split("/")[0] })) };
		} else if (backend === "pi") {
			options.env.PI_CODING_AGENT_DIR = join(agentDirectory(), "pi");
			data = JSON.parse((await output(process.execPath, [piScript(), "list"], options)).trim());
		} else throw new Error("Choose Codex, OpenCode or Pi");
		this.cache.set(backend, { at: Date.now(), data });
		return data;
	}
	register(app: Express, busy: () => boolean) {
		app.use("/api/agents/auth", (request, response, next) => {
			response.set("Cache-Control", "no-store");
			if (request.method !== "GET" && !request.is("application/json")) { response.status(415).json({ error: "Send application/json" }); return; }
			next();
		});
		app.get("/api/agents/auth", (_req, res) => res.json(this.view()));
		app.post("/api/agents/auth/start", async (req, res) => {
			try { if (busy()) throw new Error("Wait for the assistant turn to finish before signing in."); res.json(await this.start(req.body?.backend, req.body?.provider)); }
			catch (error) { res.status(400).json({ error: (error as Error).message }); }
		});
		app.post("/api/agents/auth/input", async (req, res) => {
			try { await this.input(req.body?.id, req.body?.input, req.body?.raw === true); res.json(this.view()); }
			catch (error) { res.status(400).json({ error: (error as Error).message }); }
		});
		app.post("/api/agents/auth/cancel", (req, res) => {
			if (req.body?.id !== this.login?.id) { res.status(409).json({ error: "This sign-in console has expired" }); return; }
			this.cancel(); res.json(this.view());
		});
	}
	view() {
		if (!this.login) return { id: "", backend: "", running: false, output: "", urls: [] };
		if (this.login.backend === "claude") { const state = claudeAuth.console(); this.login.output = state.output; this.login.running = state.running; }
		const { id, backend, output, running, urls, prompt, options } = this.login;
		return { id, backend, output, running, urls, prompt, options };
	}
	async start(backend: string, provider?: string) {
		if (!["codex", "claude", "opencode", "pi"].includes(backend)) throw new Error("Unknown CLI");
		this.view();
		if (this.login?.running) throw new Error("Cancel the active sign-in console before starting another.");
		const login: Login = { id: randomUUID(), backend, output: `Starting ${backend} sign-in...\r\n`, running: true, urls: [] };
		this.login = login;
		login.timer = setTimeout(() => { if (this.login === login) this.cancel(); }, 10 * 60_000); login.timer.unref();
		try {
			if (backend === "claude") { const attempt = await claudeAuth.start(); login.urls = [attempt.url]; login.id = attempt.attemptId; return this.view(); }
			const options = await nativeEnvironment(backend);
			options.env.TERM = "xterm-256color";
			if (backend === "pi") {
				if (typeof provider !== "string" || !(await this.catalog("pi")).providers?.some((p: any) => p.id === provider)) throw new Error("Choose a Pi account provider");
				options.env.PI_CODING_AGENT_DIR = join(agentDirectory(), "pi");
				login.child = spawn(process.execPath, [piScript(), "login", provider], { ...options, stdio: "pipe", detached: true });
				login.child.stderr.resume();
				createInterface({ input: login.child.stdout }).on("line", line => {
					try { const data = JSON.parse(line); login.output = (login.output + (data.output || "") + (data.prompt ? `${data.prompt}\r\n` : "")).slice(-128_000); login.prompt = data.prompt; login.options = data.options; if (data.url) login.urls.push(data.url); } catch {}
				});
			} else {
				const args = backend === "codex" ? ["login", "--device-auth"] : ["auth", "login", "--pure"];
				options.env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
				// Only a fixed login command runs in this PTY. Input never becomes shell code.
				const command = `stty cols 90 rows 24 -echo; exec ${[binary(backend), ...args].map(quoteCommand).join(" ")}`;
				login.child = spawn("script", ["-q", "-e", "-c", command, "/dev/null"], { ...options, stdio: "pipe", detached: true });
				const consume = (chunk: Buffer) => { login.output = (login.output + chunk.toString()).slice(-128_000); const plain = login.output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""); login.urls = [...new Set(plain.match(/https:\/\/[^\s<>\x1b]+/g) || [])].filter(url => { try { return new URL(url).protocol === "https:"; } catch { return false; } }).slice(-10); };
				login.child.stdout.on("data", consume); login.child.stderr.on("data", consume);
			}
			login.child.stdin.on("error", () => this.finish(login, "The sign-in client stopped accepting input. Start again.\r\n"));
			login.child.once("error", () => this.finish(login, "The CLI could not start.\r\n"));
			login.child.once("close", code => { this.finish(login, code === 0 ? "Sign-in process finished. Refresh models to check the account.\r\n" : "Sign-in ended. Start again if the account is still disconnected.\r\n"); });
			return this.view();
		} catch (error) { this.finish(login, "Sign-in could not start.\r\n"); throw error; }
	}
	async input(id: string, input: string, raw: boolean) {
		const login = this.login;
		if (!login || login.id !== id || !login.running) throw new Error("This sign-in console has expired");
		if (typeof input !== "string" || input.length > 8192 || input.includes("\0")) throw new Error("Invalid console input");
		if (login.backend === "claude") { await claudeAuth.complete(id, input); this.finish(login, "Signed in.\r\n"); return; }
		if (!login.child?.stdin.writable || login.child.stdin.destroyed) throw new Error("The sign-in client stopped accepting input. Start again.");
		if (login.backend === "pi") { login.child!.stdin.write(JSON.stringify({ input }) + "\n"); login.prompt = undefined; login.options = undefined; }
		else login.child!.stdin.write(raw ? input : input + "\n");
	}
	cancel() {
		const login = this.login;
		if (!login || !login.running) return;
		if (login.backend === "claude") claudeAuth.cancel();
		if (login.child?.pid && login.child.exitCode === null) { const pid = login.child.pid; try { process.kill(-pid, "SIGTERM"); } catch {} const force = setTimeout(() => { if (login.child?.exitCode !== null) return; try { process.kill(-pid, "SIGKILL"); } catch {} }, 2000); force.unref(); }
		this.finish(login, "Cancelled.\r\n");
	}
	private finish(login: Login, message: string) { clearTimeout(login.timer); login.running = false; login.output = (login.output + message).slice(-128_000); this.cache.delete(login.backend); if (login.backend !== "claude") void this.protect(login.backend); }
	private async protect(backend: string) { const options = await nativeEnvironment(backend); const path = backend === "opencode" ? join(options.env.XDG_DATA_HOME!, "opencode/auth.json") : join(agentDirectory(), backend, "auth.json"); await chmod(path, 0o600).catch(() => {}); }
}
