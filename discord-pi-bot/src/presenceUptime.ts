import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	open,
	readFile,
	rename,
	unlink,
} from "node:fs/promises";
import { dirname } from "node:path";

interface PresenceUptimeState {
	version: 1;
	trackingStartedAt: number;
	totalOnlineMs: number;
	lastHeartbeatAt: number;
	sessionId: string;
}

export interface UptimeSnapshot {
	totalOnlineMs: number;
	availabilityPercent: number;
	trackingStartedAt: number;
	lastHeartbeatAt: number;
}

interface PresenceUptimeDependencies {
	now?: () => number;
	sessionId?: () => string;
	logError?: (message: string) => void;
}

function isValidTime(value: unknown, now: number): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= now
	);
}

function validateState(value: unknown, now: number): PresenceUptimeState {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Presence uptime state must be an object");
	const state = value as Record<string, unknown>;
	if (
		state.version !== 1 ||
		!isValidTime(state.trackingStartedAt, now) ||
		!isValidTime(state.lastHeartbeatAt, now) ||
		typeof state.totalOnlineMs !== "number" ||
		!Number.isFinite(state.totalOnlineMs) ||
		state.totalOnlineMs < 0 ||
		typeof state.sessionId !== "string" ||
		state.sessionId.length === 0
	)
		throw new Error("Presence uptime state is invalid");
	return state as unknown as PresenceUptimeState;
}

export class PresenceUptimeTracker {
	private readonly now: () => number;
	private readonly sessionId: () => string;
	private readonly logError: (message: string) => void;
	private state: PresenceUptimeState | undefined;
	private lastSampleAt = 0;

	constructor(
		private readonly path: string,
		dependencies: PresenceUptimeDependencies = {},
	) {
		this.now = dependencies.now || Date.now;
		this.sessionId = dependencies.sessionId || randomUUID;
		this.logError = dependencies.logError || ((message) => console.error(message));
	}

	async initialize(): Promise<UptimeSnapshot> {
		const now = this.now();
		let state = await this.load(now);
		if (!state) {
			state = {
				version: 1,
				trackingStartedAt: now,
				totalOnlineMs: 0,
				lastHeartbeatAt: now,
				sessionId: this.sessionId(),
			};
		} else {
			state = {
				...state,
				lastHeartbeatAt: now,
				sessionId: this.sessionId(),
			};
		}
		this.state = state;
		this.lastSampleAt = now;
		await this.persistSafely();
		return this.snapshot(now);
	}

	async sample(): Promise<UptimeSnapshot> {
		if (!this.state) return this.initialize();
		const now = this.now();
		const elapsed = Math.max(0, now - this.lastSampleAt);
		this.state.totalOnlineMs += elapsed;
		this.lastSampleAt = Math.max(this.lastSampleAt, now);
		this.state.lastHeartbeatAt = Math.max(this.state.lastHeartbeatAt, now);
		await this.persistSafely();
		return this.snapshot(now);
	}

	private snapshot(now: number): UptimeSnapshot {
		if (!this.state) throw new Error("Presence uptime tracker is not initialized");
		const lifetime = Math.max(0, now - this.state.trackingStartedAt);
		const availabilityPercent =
			lifetime === 0
				? 100
				: Math.min(100, Math.max(0, (this.state.totalOnlineMs / lifetime) * 100));
		return {
			totalOnlineMs: this.state.totalOnlineMs,
			availabilityPercent,
			trackingStartedAt: this.state.trackingStartedAt,
			lastHeartbeatAt: this.state.lastHeartbeatAt,
		};
	}

	private async load(now: number): Promise<PresenceUptimeState | undefined> {
		let contents: string;
		try {
			contents = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				this.logError("Presence uptime state could not be read; using memory only.");
			return undefined;
		}
		try {
			return validateState(JSON.parse(contents), now);
		} catch {
			await this.quarantine(now);
			return undefined;
		}
	}

	private async quarantine(now: number): Promise<void> {
		try {
			await rename(this.path, `${this.path}.${now}.corrupt`);
		} catch {
			this.logError("Corrupt presence uptime state could not be quarantined.");
		}
	}

	private async persistSafely(): Promise<void> {
		if (!this.state) return;
		try {
			await this.persist(this.state);
		} catch {
			this.logError("Presence uptime state could not be persisted; using memory only.");
		}
	}

	private async persist(state: PresenceUptimeState): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const handle = await open(temporary, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(state), "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await rename(temporary, this.path);
			await chmod(this.path, 0o600);
		} catch (error) {
			await unlink(temporary).catch(() => {});
			throw error;
		}
	}
}
