import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from "./claude";
import { CompatibleProvider, OPENCODE_GO_URL } from "./compatible";
import { OpenAiProvider } from "./openai";
import type { Effort, Provider, ProviderId } from "./types";

export const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
	{ id: "claude", label: "Claude" },
	{ id: "openai", label: "OpenAI" },
	{ id: "opencode", label: "OpenCode" },
	{ id: "custom", label: "Custom server" },
];

const EFFORTS: Effort[] = ["low", "medium", "high"];

/** What the console may change. Keys only ever come from the app options. */
interface Choice {
	provider?: ProviderId;
	models?: Partial<Record<ProviderId, string>>;
	effort?: Effort;
}

export interface AiStatus {
	provider: ProviderId | "";
	label: string;
	model: string;
	effort: Effort;
	ready: boolean;
	/** Why the assistant can't answer yet, in words for the console and Discord. */
	problem: string;
	providers: Array<{ id: ProviderId; label: string; configured: boolean; model: string }>;
	webSearch: "provider" | "searxng" | "none";
	vision: boolean;
}

function isProvider(value: unknown): value is ProviderId {
	return PROVIDERS.some((provider) => provider.id === value);
}

function isEffort(value: unknown): value is Effort {
	return EFFORTS.includes(value as Effort);
}

/**
 * Which AI answers, with which model, at what effort. The app options supply
 * the keys and the defaults; the console's choice is saved on top of them, so
 * switching between Claude, OpenAI and OpenCode needs no restart.
 */
export class AiSettings {
	private choice: Choice = {};
	private cached?: { key: string; provider: Provider };

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly path = env.AI_DATA_PATH || "./data/ai.json",
	) {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Choice;
			this.choice = {
				provider: isProvider(saved.provider) ? saved.provider : undefined,
				models: saved.models && typeof saved.models === "object" ? saved.models : {},
				effort: isEffort(saved.effort) ? saved.effort : undefined,
			};
		} catch {
			this.choice = {};
		}
	}

	private key(id: ProviderId): string {
		switch (id) {
			case "claude":
				return this.env.ANTHROPIC_API_KEY || "";
			case "openai":
				return this.env.OPENAI_API_KEY || "";
			case "opencode":
				return this.env.OPENCODE_API_KEY || "";
			case "custom":
				return this.env.CUSTOM_AI_KEY || "";
		}
	}

	configured(id: ProviderId): boolean {
		return id === "custom" ? Boolean(this.env.CUSTOM_AI_URL) : Boolean(this.key(id));
	}

	private defaultProvider(): ProviderId {
		const option = this.env.AI_PROVIDER;
		if (isProvider(option) && this.configured(option)) return option;
		return PROVIDERS.find((provider) => this.configured(provider.id))?.id || (isProvider(option) ? option : "claude");
	}

	providerId(): ProviderId {
		const chosen = this.choice.provider;
		return chosen && this.configured(chosen) ? chosen : this.defaultProvider();
	}

	model(id = this.providerId()): string {
		const chosen = this.choice.models?.[id];
		if (chosen) return chosen;
		if (this.env.AI_MODEL && id === this.defaultProvider()) return this.env.AI_MODEL;
		return id === "claude" ? DEFAULT_CLAUDE_MODEL : "";
	}

	effort(): Effort {
		if (this.choice.effort) return this.choice.effort;
		return isEffort(this.env.AI_EFFORT) ? this.env.AI_EFFORT : "low";
	}

	dailyBudget(): number {
		const raw = this.env.DAILY_AI_BUDGET;
		const value = raw === undefined || raw.trim() === "" ? 2 : Number(raw);
		return Number.isFinite(value) && value >= 0 ? value : 2;
	}

	build(id: ProviderId, model: string): Provider {
		switch (id) {
			case "claude":
				return new ClaudeProvider(this.key(id), model || DEFAULT_CLAUDE_MODEL);
			case "openai":
				return new OpenAiProvider(this.key(id), model);
			case "opencode":
				return new CompatibleProvider("opencode", "OpenCode", this.key(id), model, this.env.OPENCODE_URL || OPENCODE_GO_URL);
			case "custom":
				return new CompatibleProvider("custom", "Custom server", this.key(id), model, this.env.CUSTOM_AI_URL || "");
		}
	}

	problem(): string {
		const id = this.providerId();
		const label = PROVIDERS.find((provider) => provider.id === id)?.label || id;
		if (!this.configured(id))
			return id === "custom"
				? "No AI is set up yet. Add an API key for Claude, OpenAI or OpenCode in the RemindMe app's options, then restart it."
				: `No ${label} API key is set. Add one in the RemindMe app's options, then restart the app.`;
		if (!this.model(id)) return `Pick a model for ${label} in RemindMe's AI settings.`;
		return "";
	}

	/** The provider to use now, or undefined with `problem()` saying why. */
	provider(): Provider | undefined {
		if (this.problem()) return undefined;
		const id = this.providerId();
		const model = this.model(id);
		const key = `${id}:${model}`;
		if (this.cached?.key !== key) this.cached = { key, provider: this.build(id, model) };
		return this.cached.provider;
	}

	async listModels(id: ProviderId): Promise<string[]> {
		if (!this.configured(id)) return [];
		return this.build(id, this.model(id) || "-").listModels();
	}

	async choose(update: { provider?: unknown; model?: unknown; effort?: unknown }): Promise<void> {
		const next: Choice = { ...this.choice, models: { ...(this.choice.models || {}) } };
		if (update.provider !== undefined) {
			if (!isProvider(update.provider)) throw new Error("Unknown AI provider");
			if (!this.configured(update.provider))
				throw new Error("That provider has no API key yet. Add it in the app options first.");
			next.provider = update.provider;
		}
		if (update.model !== undefined) {
			const model = String(update.model).trim();
			if (model.length > 200) throw new Error("That model name is too long");
			const id = next.provider || this.providerId();
			if (model) next.models![id] = model;
			else delete next.models![id];
		}
		if (update.effort !== undefined) {
			if (!isEffort(update.effort)) throw new Error("Effort must be low, medium or high");
			next.effort = update.effort;
		}
		this.choice = next;
		await mkdir(dirname(this.path), { recursive: true });
		await writeFile(`${this.path}.tmp`, JSON.stringify(this.choice, null, 2));
		await rename(`${this.path}.tmp`, this.path);
	}

	status(searchFallback: boolean): AiStatus {
		const id = this.providerId();
		const problem = this.problem();
		const provider = problem ? undefined : this.provider();
		return {
			provider: id,
			label: PROVIDERS.find((entry) => entry.id === id)?.label || id,
			model: this.model(id),
			effort: this.effort(),
			ready: !problem,
			problem,
			providers: PROVIDERS.map((entry) => ({
				...entry,
				configured: this.configured(entry.id),
				model: this.model(entry.id),
			})),
			webSearch: provider?.nativeWebSearch ? "provider" : searchFallback ? "searxng" : "none",
			vision: Boolean(provider?.vision),
		};
	}
}
