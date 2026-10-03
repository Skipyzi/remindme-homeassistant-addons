import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { agentDirectory } from "./runtime-store";

export const binary = (name: string) => process.env[`${name.toUpperCase()}_CLI_PATH`] || join(process.cwd(), "node_modules/.bin", name);
export async function nativeEnvironment(name: string): Promise<{ cwd: string; env: NodeJS.ProcessEnv }> {
	const home = name === "claude" ? resolve(process.env.CLAUDE_CONFIG_DIR || "./data/claude-auth") : join(agentDirectory(), name);
	const cwd = join(home, "work");
	await mkdir(cwd, { recursive: true, mode: 0o700 });
	// Deliberate allowlist: never inherit Supervisor, Discord or unrelated API credentials.
	return { cwd, env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"), XDG_CACHE_HOME: join(home, "cache"), CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, TERM: "dumb", BROWSER: "/bin/true", DISABLE_AUTOUPDATER: "1" } };
}

export class JsonProcess {
	readonly child: ChildProcessWithoutNullStreams;
	private seq = 0;
	private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
	private stopped = false;
	private onAbort: () => void;
	private timeout: ReturnType<typeof setTimeout>;
	readonly finished: Promise<void>;
	constructor(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal }, private consume: (message: any) => Promise<void> | void) {
		options.signal.throwIfAborted();
		this.child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "pipe", detached: process.platform !== "win32" });
		this.child.stderr.resume();
		this.onAbort = () => this.stop();
		options.signal.addEventListener("abort", this.onAbort, { once: true });
		this.timeout = setTimeout(() => this.stop(), 10 * 60_000);
		this.timeout.unref();
		this.finished = new Promise<void>((resolve, reject) => {
			this.child.once("error", () => reject(new Error(`The ${command.split("/").pop()} client could not start`)));
			this.child.once("close", code => code === 0 ? resolve() : reject(new Error(options.signal.aborted ? "Assistant turn cancelled" : "Agent client exited before completing the turn. Check its sign-in and selected model.")));
		}).finally(() => {
			this.stopped = true;
			clearTimeout(this.timeout);
			options.signal.removeEventListener("abort", this.onAbort);
			for (const entry of this.pending.values()) entry.reject(new Error("Agent client disconnected"));
			this.pending.clear();
		});
		// The caller awaits finished; attach a rejection observer immediately for early exits.
		void this.finished.catch(() => {});
		const lines = createInterface({ input: this.child.stdout });
		lines.on("line", line => {
			if (line.length > 2_000_000) { this.stop(); return; }
			let message: any;
			try { message = JSON.parse(line); } catch { return; }
			if (message.id !== undefined && !message.method && this.pending.has(message.id)) {
				const request = this.pending.get(message.id)!;
				this.pending.delete(message.id);
				message.error ? request.reject(new Error(message.error.message || "Agent protocol request failed")) : request.resolve(message.result);
			} else void Promise.resolve(this.consume(message)).catch(() => this.stop());
		});
	}
	write(message: unknown) { if (!this.stopped && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(message)}\n`); }
	request(method: string, params: unknown): Promise<any> {
		if (this.stopped) return Promise.reject(new Error("Agent client disconnected"));
		const id = ++this.seq;
		return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ id, method, params }); });
	}
	stop() {
		if (this.stopped) return;
		this.stopped = true;
		try { if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGTERM"); else this.child.kill(); } catch { /* Already exited. */ }
		const kill = setTimeout(() => { try { if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, "SIGKILL"); else this.child.kill("SIGKILL"); } catch { /* Already exited. */ } }, 2000);
		kill.unref();
	}
}
