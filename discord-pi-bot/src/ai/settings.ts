import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { RUNNER_LABELS, RUNNERS, type RunnerId } from "../agents/runners";
import { catalogEntries } from "./catalog";
import { ClaudeProvider, DEFAULT_CLAUDE_MODEL } from "./claude";
import { OpenAiProvider, type Subscription } from "./openai";
import type { Effort, Provider, ProviderId } from "./types";

/** Everything that can answer: an AI the assistant drives, or a CLI agent that runs the turn itself. */
export type AssistantId = ProviderId | RunnerId;

export const PROVIDERS: Array<{ id: AssistantId; label: string; kind: "api" | "subscription" | "agent" }> = [
	{ id: "claude", label: "Claude", kind: "api" },
	{ id: "openai", label: "OpenAI", kind: "api" },
	{ id: "chatgpt", label: "ChatGPT subscription", kind: "subscription" },
	{ id: "claude-code", label: RUNNER_LABELS["claude-code"], kind: "agent" },
	{ id: "codex", label: RUNNER_LABELS.codex, kind: "agent" },
];

/* The Claude subscription runs through Claude Code, which names models by family. */
export const CLAUDE_CODE_MODELS = ["sonnet", "opus", "haiku"];

const EFFORTS: Effort[] = ["low", "medium", "high"];

/** A model picked for one thread or one chore, instead of the one chosen under AI. */
export interface ModelChoice {
	provider: AssistantId;
	model: string;
}

/** Which sign-ins are connected. Refreshed from disk and the CLIs, read synchronously. */
export interface Accounts {
	chatgpt: boolean;
	claude: boolean;
	codex: boolean;
}

/** What the subscriptions and agents need from the rest of the app. */
export interface SignIns {
	accounts(): Promise<Accounts>;
	chatgpt: Subscription;
	chatgptModels(): Promise<string[]>;
	agentModels(runner: "codex"): Promise<string[]>;
}

/** What the console may change. Keys only ever come from the app options. */
interface Choice {
	provider?: AssistantId;
	models?: Partial<Record<AssistantId, string>>;
	effort?: Effort;
}

export interface Runner {
	id: RunnerId;
	label: string;
	model: string;
	/** Codex on its own CLI sign-in instead of the ChatGPT sign-in. */
	nativeAuth: boolean;
}

export interface AiStatus {
	provider: AssistantId | "";
	label: string;
	model: string;
	effort: Effort;
	ready: boolean;
	/** Why the assistant can't answer yet, in words for the console and Discord. */
	problem: string;
	providers: Array<{ id: AssistantId; label: string; kind: string; configured: boolean; model: string }>;
	accounts: Accounts;
	webSearch: "provider" | "searxng" | "none";
	vision: boolean;
}

function isAssistant(value: unknown): value is AssistantId {
	return PROVIDERS.some((provider) => provider.id === value);
}

export function isRunner(value: unknown): value is RunnerId {
	return RUNNERS.includes(value as RunnerId);
}

function isEffort(value: unknown): value is Effort {
	return EFFORTS.includes(value as Effort);
}

const NO_ACCOUNTS: Accounts = { chatgpt: false, claude: false, codex: false };

/**
 * Which AI answers, with which model, at what effort. The app options supply
 * the keys and the defaults; the console's choice is saved on top of them, so
 * switching between Claude, OpenAI, the subscriptions and the CLI
 * agents needs no restart.
 */
export class AiSettings {
	private choice: Choice = {};
	private cached?: { key: string; provider: Provider };
	private accounts: Accounts = { ...NO_ACCOUNTS };

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly path = env.AI_DATA_PATH || "./data/ai.json",
		private readonly signIns?: SignIns,
	) {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Choice;
			this.choice = {
				provider: isAssistant(saved.provider) ? saved.provider : undefined,
				models: saved.models && typeof saved.models === "object" ? saved.models : {},
				effort: isEffort(saved.effort) ? saved.effort : undefined,
			};
		} catch {
			this.choice = {};
		}
		await this.refreshAccounts();
	}

	/** Re-read which sign-ins are connected: at start, after a sign-in, and when the console looks. */
	async refreshAccounts(): Promise<Accounts> {
		if (!this.signIns) return this.accounts;
		try {
			this.accounts = await this.signIns.accounts();
		} catch (error) {
			console.warn("Could not read the sign-ins:", error instanceof Error ? error.message : error);
		}
		return this.accounts;
	}

	private key(id: ProviderId): string {
		switch (id) {
			case "claude":
				return this.env.ANTHROPIC_API_KEY || "";
			case "openai":
				return this.env.OPENAI_API_KEY || "";
			case "chatgpt":
				return "";
		}
	}

	configured(id: AssistantId): boolean {
		switch (id) {
			case "chatgpt":
				return this.accounts.chatgpt;
			case "claude-code":
				return this.accounts.claude;
			case "codex":
				return this.accounts.chatgpt || this.accounts.codex;
			default:
				return Boolean(this.key(id));
		}
	}

	private defaultProvider(): AssistantId {
		const option = this.env.AI_PROVIDER;
		if (isAssistant(option) && this.configured(option)) return option;
		return PROVIDERS.find((provider) => this.configured(provider.id))?.id || (isAssistant(option) ? option : "claude");
	}

	providerId(): AssistantId {
		const chosen = this.choice.provider;
		return chosen && this.configured(chosen) ? chosen : this.defaultProvider();
	}

	model(id = this.providerId()): string {
		const chosen = this.choice.models?.[id];
		if (chosen) return chosen;
		if (this.env.AI_MODEL && id === this.defaultProvider() && PROVIDERS.find((entry) => entry.id === id)?.kind === "api") return this.env.AI_MODEL;
		if (id === "claude") return DEFAULT_CLAUDE_MODEL;
		if (id === "chatgpt" && this.env.CHATGPT_MODEL) return this.env.CHATGPT_MODEL;
		if (id === "claude-code") return "sonnet";
		return "";
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
			case "chatgpt":
				if (!this.signIns) throw new Error("ChatGPT sign-in isn't available here.");
				return new OpenAiProvider("", model, { subscription: this.signIns.chatgpt });
		}
	}

	private label(id: AssistantId): string {
		return PROVIDERS.find((provider) => provider.id === id)?.label || id;
	}

	problem(): string {
		const id = this.providerId();
		const label = this.label(id);
		if (!this.configured(id)) {
			if (!PROVIDERS.some((provider) => this.configured(provider.id)))
				return "No AI is set up yet. Add an API key for Claude or OpenAI in the RemindMe app's options, or sign in under AI in the RemindMe console.";
			return PROVIDERS.find((entry) => entry.id === id)?.kind === "api"
				? `No ${label} API key is set. Add one in the RemindMe app's options, then restart the app.`
				: `${label} isn't signed in. Sign in under AI in the RemindMe console.`;
		}
		if (!this.model(id)) return `Pick a model for ${label} in RemindMe's AI settings.`;
		return "";
	}

	/** The AI the assistant drives now, or undefined for a CLI agent or with `problem()` saying why. */
	provider(): Provider | undefined {
		if (this.problem()) return undefined;
		const id = this.providerId();
		if (isRunner(id)) return undefined;
		const model = this.model(id);
		const key = `${id}:${model}`;
		if (this.cached?.key !== key) this.cached = { key, provider: this.build(id, model) };
		return this.cached.provider;
	}

	/** The same AI on its cheapest model, for small chores such as reading a price off a page. */
	cheapProvider(): Provider | undefined {
		if (this.problem()) return undefined;
		const id = this.providerId();
		if (isRunner(id)) return undefined;
		const model = id === "claude" ? "claude-haiku-5-5" : "gpt-6-luna";
		const key = `${id}:${model}`;
		if (this.cheapCached?.key !== key) this.cheapCached = { key, provider: this.build(id, model) };
		return this.cheapCached.provider;
	}
	private cheapCached?: { key: string; provider: Provider };

	/** The models a thread or a chore can be given: each set-up provider's current ones, and the one picked for it under AI. */
	choices(): Array<{ provider: AssistantId; label: string; models: Array<{ id: string; name: string }> }> {
		return PROVIDERS.filter((entry) => this.configured(entry.id))
			.map((entry) => {
				const models = catalogEntries(entry.id).map((row) => ({ id: row.id, name: row.name }));
				const chosen = this.model(entry.id);
				if (chosen && !models.some((row) => row.id === chosen)) models.unshift({ id: chosen, name: chosen });
				return { provider: entry.id, label: entry.label, models };
			})
			.filter((group) => group.models.length);
	}

	/** A choice sent by the console, checked: a provider that's set up, and a model name. */
	checkChoice(value: unknown): ModelChoice | undefined {
		if (!value || typeof value !== "object") return undefined;
		const { provider, model } = value as Record<string, unknown>;
		if (!isAssistant(provider) || !this.configured(provider) || typeof model !== "string" || !/^[\w.:/-]{1,100}$/.test(model)) return undefined;
		return { provider, model };
	}

	/** A choice in plain words: "Claude Haiku 5.5", or the provider and model name. */
	choiceName(choice: ModelChoice): string {
		return catalogEntries(choice.provider).find((row) => row.id === choice.model)?.name || `${this.label(choice.provider)} ${choice.model}`;
	}

	/**
	 * What answers for a thread or a chore with a model of its own: that
	 * model, or the AI chosen under AI when there's none or its provider
	 * isn't set up any more.
	 */
	pick(choice?: ModelChoice): { provider?: Provider; runner?: Runner; problem: string } {
		if (choice && choice.model && this.configured(choice.provider)) {
			if (isRunner(choice.provider)) return { runner: { id: choice.provider, label: this.label(choice.provider), model: choice.model, nativeAuth: choice.provider === "codex" && !this.accounts.chatgpt }, problem: "" };
			const key = `${choice.provider}:${choice.model}`;
			let provider = this.picked.get(key);
			if (!provider) {
				provider = this.build(choice.provider as ProviderId, choice.model);
				this.picked.set(key, provider);
			}
			return { provider, problem: "" };
		}
		return { provider: this.provider(), runner: this.runner(), problem: this.problem() };
	}
	private picked = new Map<string, Provider>();

	/** The CLI agent that runs turns now, if one is chosen. */
	runner(): Runner | undefined {
		if (this.problem()) return undefined;
		const id = this.providerId();
		if (!isRunner(id)) return undefined;
		return { id, label: this.label(id), model: this.model(id), nativeAuth: id === "codex" && !this.accounts.chatgpt };
	}

	async listModels(id: AssistantId): Promise<string[]> {
		if (!this.configured(id)) return [];
		if (id === "claude-code") return CLAUDE_CODE_MODELS;
		if (id === "chatgpt" || (id === "codex" && this.accounts.chatgpt)) return this.signIns ? this.signIns.chatgptModels() : [];
		if (id === "codex") return this.signIns ? this.signIns.agentModels(id) : [];
		return this.build(id, this.model(id) || "-").listModels();
	}

	async choose(update: { provider?: unknown; model?: unknown; effort?: unknown }): Promise<void> {
		const next: Choice = { ...this.choice, models: { ...(this.choice.models || {}) } };
		if (update.provider !== undefined) {
			if (!isAssistant(update.provider)) throw new Error("Unknown AI provider");
			if (!this.configured(update.provider))
				throw new Error(
					PROVIDERS.find((entry) => entry.id === update.provider)?.kind === "api"
						? "That provider has no API key yet. Add it in the app options first."
						: "Sign in to that one first.",
				);
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
		const runner = isRunner(id);
		return {
			provider: id,
			label: this.label(id),
			model: this.model(id),
			effort: this.effort(),
			ready: !problem,
			problem,
			providers: PROVIDERS.map((entry) => ({ ...entry, configured: this.configured(entry.id), model: this.model(entry.id) })),
			accounts: this.accounts,
			webSearch: provider?.nativeWebSearch ? "provider" : searchFallback ? "searxng" : "none",
			vision: !runner && Boolean(provider?.vision),
		};
	}
}
