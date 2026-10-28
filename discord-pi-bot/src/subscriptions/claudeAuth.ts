import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function cliEnvironment(): NodeJS.ProcessEnv {
	const directory = resolve(process.env.CLAUDE_CONFIG_DIR || "./data/claude-auth");
	return { PATH: process.env.PATH, HOME: directory, CLAUDE_CONFIG_DIR: directory, BROWSER: "/bin/true", TERM: "dumb", DISABLE_AUTOUPDATER: "1" };
}
async function workDirectory() {
	const directory = join(resolve(process.env.CLAUDE_CONFIG_DIR || "./data/claude-auth"), "work");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	return directory;
}
function cli(args: string[], cwd: string, signal?: AbortSignal) {
	return spawn(process.env.CLAUDE_CLI_PATH || join(process.cwd(), "node_modules/.bin/claude"), args, { cwd, env: cliEnvironment(), stdio: "pipe", signal });
}

export class ClaudeAuth {
	private transcript = "";
	console() { return { output: this.transcript, attemptId: this.login?.id || "", running: Boolean(this.login) }; }
	private login?: { id: string; process: ChildProcessWithoutNullStreams; url: string; error: string; timer: ReturnType<typeof setTimeout> };
	async status() {
		const process = cli(["auth", "status"], await workDirectory());
		let output = "";
		process.stdout.on("data", (chunk) => { output += chunk; });
		process.stderr.resume();
		const timer = setTimeout(() => process.kill(), 10_000);
		try {
			await new Promise<void>((resolve, reject) => { process.once("error", reject); process.once("close", () => resolve()); });
			let data: Record<string, any> = {};
			try { data = JSON.parse(output); } catch { /* Not connected. */ }
			return { connected: Boolean(data.loggedIn && ["claude.ai", "oauth_token"].includes(data.authMethod)), email: typeof data.email === "string" ? data.email : "", pending: Boolean(this.login), error: this.login?.error || "" };
		} finally { clearTimeout(timer); }
	}
	async start() {
		this.cancel();
		this.transcript = "Starting Claude subscription sign-in...\r\n";
		const process = cli(["auth", "login", "--claudeai"], await workDirectory());
		const id = randomUUID();
		const login = { id, process, url: "", error: "", timer: setTimeout(() => this.cancel(), 600_000) };
		login.timer.unref();
		this.login = login;
		let output = "";
		return new Promise<{ attemptId: string; url: string; instructions: string }>((resolve, reject) => {
			const timeout = setTimeout(() => { this.cancel(); reject(new Error("Claude sign-in did not start. Retry.")); }, 30_000);
			const consume = (chunk: Buffer) => {
				this.transcript = (this.transcript + chunk.toString()).slice(-64_000);
				output = (output + chunk.toString()).slice(-16_000);
				const match = output.match(/https:\/\/[^\s\x1b]+/);
				if (!match) return;
				const url = new URL(match[0]);
				if (!["claude.ai", "claude.com", "platform.claude.com"].includes(url.hostname)) return;
				login.url = url.toString();
				clearTimeout(timeout);
				resolve({ attemptId: id, url: login.url, instructions: "Sign in with your Claude subscription, then paste the code shown by Claude below. Third-party usage may use paid usage credits." });
			};
			process.stdout.on("data", consume);
			process.stderr.on("data", consume);
			process.once("error", () => { clearTimeout(timeout); this.cancel(); reject(new Error("The Claude client could not start.")); });
			process.once("close", (code) => { clearTimeout(timeout); if (this.login === login) { clearTimeout(login.timer); this.login = undefined; } if (code !== 0) login.error = "Claude sign-in failed. Start again."; if (!login.url) reject(new Error(login.error || "Claude sign-in ended without an authorization link.")); });
		});
	}
	async complete(id: string, code: string) {
		const login = this.login;
		if (!login || login.id !== id || login.process.exitCode !== null) throw new Error("This Claude sign-in attempt expired. Start again.");
		if (!code.trim() || /[\r\n]/.test(code)) throw new Error("Paste the single code shown by Claude.");
		login.process.stdin.write(`${code.trim()}\n`);
		const exit = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => { this.cancel(); reject(new Error("Claude sign-in timed out.")); }, 30_000);
			login.process.once("close", (status) => { clearTimeout(timer); resolve(status); });
		});
		this.cancel();
		if (exit !== 0) throw new Error("Claude sign-in failed. Start again.");
		return this.status();
	}
	cancel() { if (this.login) { clearTimeout(this.login.timer); this.login.process.kill(); this.login = undefined; } }
	async logout() {
		this.cancel();
		const process = cli(["auth", "logout"], await workDirectory());
		const timer = setTimeout(() => process.kill(), 15_000);
		try { await new Promise<void>((resolve, reject) => { process.once("error", reject); process.once("close", (code) => code === 0 ? resolve() : reject(new Error("Claude logout failed"))); }); }
		finally { clearTimeout(timer); }
	}
}

export const claudeAuth = new ClaudeAuth();
