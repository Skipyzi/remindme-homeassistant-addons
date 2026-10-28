import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { RequestHandler } from "express";

export type PhoneState = "off" | "starting" | "needs_login" | "running" | "error";

export interface PhoneStatus {
	state: PhoneState;
	/** The app's address on the tailnet: https://remindme.tail1234.ts.net */
	url?: string;
	/** The Tailscale account that connected RemindMe; only it may open the app. */
	owner?: string;
	/** Where to sign in, while signing in. */
	authUrl?: string;
	/** HTTPS isn't on for the tailnet yet: where to turn it on. */
	enableHttpsUrl?: string;
	error?: string;
}

/** One `tailscale` command; answers its output. */
export type TailscaleCli = (args: string[], timeoutMs: number) => Promise<string>;

function cli(socket: string): TailscaleCli {
	return (args, timeoutMs) =>
		new Promise((resolve, reject) => {
			execFile(process.env.TAILSCALE_CLI || "tailscale", ["--socket", socket, ...args], { timeout: timeoutMs, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
				if (error) reject(new Error(`${stderr || stdout || error.message}`.trim()));
				else resolve(String(stdout));
			});
		});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * RemindMe as its own device on the user's tailnet, for the phone app. The
 * Tailscale daemon runs inside the app (started by run.sh, userspace
 * networking, state in /data/tailscale); `tailscale serve` gives it an HTTPS
 * address and tells each request which tailnet account it comes from.
 */
export class TailscaleNode {
	private ownerLogin?: string;
	private served = false;
	private enableHttpsUrl?: string;
	private signingIn?: ChildProcess;

	constructor(
		private readonly socket = process.env.TAILSCALE_SOCKET || "",
		private readonly port = Number(process.env.HARNESS_PORT || 8090),
		private readonly run: TailscaleCli = cli(socket),
		private readonly startLogin: () => ChildProcess = () =>
			spawn(process.env.TAILSCALE_CLI || "tailscale", ["--socket", this.socket, "up", "--hostname=remindme", "--accept-dns=false"], { stdio: "ignore" }),
	) {}

	get enabled(): boolean {
		return Boolean(this.socket);
	}

	/** The account allowed in, once known. */
	owner(): string | undefined {
		return this.ownerLogin;
	}

	async status(): Promise<PhoneStatus> {
		if (!this.enabled) return { state: "off" };
		let data: { BackendState?: string; AuthURL?: string; Self?: { DNSName?: string; UserID?: number | string }; User?: Record<string, { LoginName?: string }> };
		try {
			data = JSON.parse(await this.run(["status", "--json"], 8_000));
		} catch {
			return { state: "error", error: "Tailscale isn't answering inside the app yet. It may still be starting." };
		}
		const backend = String(data.BackendState || "");
		if (backend === "Running") {
			this.ownerLogin = data.User?.[String(data.Self?.UserID)]?.LoginName || this.ownerLogin;
			const name = String(data.Self?.DNSName || "").replace(/\.$/, "");
			await this.serve();
			return { state: "running", url: name ? `https://${name}` : undefined, owner: this.ownerLogin, ...(this.enableHttpsUrl ? { enableHttpsUrl: this.enableHttpsUrl } : {}) };
		}
		if (backend === "NeedsMachineAuth") return { state: "needs_login", error: "Approve the new RemindMe device in the Tailscale admin console." };
		if (backend === "Starting") return { state: "starting" };
		return { state: "needs_login", ...(data.AuthURL ? { authUrl: data.AuthURL } : {}) };
	}

	/** Start signing in; answers once the sign-in link is there. */
	async connect(): Promise<PhoneStatus> {
		if (!this.enabled) return { state: "off" };
		if (!this.signingIn) {
			const child = this.startLogin();
			this.signingIn = child;
			// `tailscale up` waits for the link to be used; give up after a while.
			const timer = setTimeout(() => child.kill(), 15 * 60_000);
			timer.unref();
			const done = () => {
				clearTimeout(timer);
				if (this.signingIn === child) this.signingIn = undefined;
			};
			child.once("exit", done);
			child.once("error", done);
		}
		for (let tries = 0; tries < 30; tries++) {
			const status = await this.status();
			if (status.authUrl || status.state === "running") return status;
			await sleep(500);
		}
		return this.status();
	}

	/* Once per start: HTTPS on 443 to the console. Needs HTTPS on for the tailnet. */
	private async serve(): Promise<void> {
		if (this.served) return;
		try {
			await this.run(["serve", "--bg", "--yes", `http://127.0.0.1:${this.port}`], 20_000);
			this.served = true;
			this.enableHttpsUrl = undefined;
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			this.enableHttpsUrl = text.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
			if (!this.enableHttpsUrl) console.warn("Tailscale serve failed:", text.split("\n").slice(-2).join(" "));
		}
	}
}

/*
 * The phone app comes in through Tailscale's HTTPS proxy: from 127.0.0.1, with
 * forwarding headers and the tailnet account it comes from. Only the account
 * that connected RemindMe gets in; a tagged device, which Tailscale sends
 * without an account, doesn't. The Home Assistant panel and the app's own
 * helpers come in without those headers and aren't affected.
 */
export function tailnetGuard(node: Pick<TailscaleNode, "owner" | "status">): RequestHandler {
	return async (request, response, next) => {
		const loopback = /^(::ffff:)?127\.|^::1$/.test(request.socket.remoteAddress || "");
		const login = request.get("Tailscale-User-Login");
		if (!loopback || !(login || request.get("X-Forwarded-For") || request.get("X-Forwarded-Host"))) return next();
		const owner = node.owner() || (await node.status()).owner;
		if (login && owner && login.toLowerCase() === owner.toLowerCase()) return next();
		response.status(403).type("text/plain").send("This RemindMe belongs to another Tailscale account. Open it from a device signed in as its owner.");
	};
}
