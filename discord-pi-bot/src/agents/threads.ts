import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDirectory } from "./paths";
import type { RunnerId } from "./runners";

type Threads = Record<string, Partial<Record<RunnerId, string>> & { at?: number }>;

const MAX_CONVERSATIONS = 300;

/**
 * Which CLI session belongs to which conversation, per agent, so the next
 * turn resumes it. A conversation that starts over gets a new key, and so a
 * fresh session.
 */
export class RunnerThreads {
	private threads: Threads;

	constructor(private readonly path = join(agentDirectory(), "threads.json")) {
		try {
			this.threads = JSON.parse(readFileSync(path, "utf8")) as Threads;
		} catch {
			this.threads = {};
		}
	}

	get(conversation: string, runner: RunnerId): string | undefined {
		return this.threads[conversation]?.[runner];
	}

	set(conversation: string, runner: RunnerId, id: string): void {
		this.threads[conversation] = { ...this.threads[conversation], [runner]: id, at: Date.now() };
		const keys = Object.keys(this.threads);
		if (keys.length > MAX_CONVERSATIONS)
			for (const key of keys.sort((a, b) => (this.threads[a].at || 0) - (this.threads[b].at || 0)).slice(0, keys.length - MAX_CONVERSATIONS))
				delete this.threads[key];
		try {
			mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
			writeFileSync(`${this.path}.tmp`, JSON.stringify(this.threads), { mode: 0o600 });
			renameSync(`${this.path}.tmp`, this.path);
		} catch (error) {
			console.warn("Could not save agent sessions:", error instanceof Error ? error.message : error);
		}
	}
}
