import { createHash } from "node:crypto";
import { validateLocalModelUrl } from "./settings";

export interface AddonOptions {
	discord_token: string;
	owner_id: string;
	pi_agent_webhook_url: string;
	local_llm_enabled: boolean;
	local_llm_url: string;
	local_llm_model: string;
	local_llm_context_size: number;
	local_llm_vision: boolean;
	model_manager_enabled: boolean;
	model_manager_url: string;
	exa_api_key: string;
	ha_notify_target: string;
}

export interface PublicAddonSettings {
	discordTokenConfigured: boolean;
	ownerId: string;
	piAgentWebhookUrl: string;
	localLlmEnabled: boolean;
	localLlmUrl: string;
	localLlmModel: string;
	localLlmContextSize: number;
	localLlmVision: boolean;
	modelManagerEnabled: boolean;
	modelManagerUrl: string;
	exaApiKeyConfigured: boolean;
	notifyTarget: string;
}

export class AddonSettingsError extends Error {
	constructor(
		public readonly code: "invalid_settings",
		message: string,
	) {
		super(message);
	}
}

const stringFields = [
	"discord_token",
	"owner_id",
	"pi_agent_webhook_url",
	"local_llm_url",
	"local_llm_model",
	"model_manager_url",
	"exa_api_key",
	"ha_notify_target",
] as const;
const booleanFields = [
	"local_llm_enabled",
	"local_llm_vision",
	"model_manager_enabled",
] as const;

function invalid(message: string): never {
	throw new AddonSettingsError("invalid_settings", message);
}

export function normalizeAddonOptions(options: unknown): AddonOptions {
	if (!options || typeof options !== "object" || Array.isArray(options))
		return invalid("Add-on options must be an object");
	const source = options as Record<string, unknown>;
	for (const field of stringFields)
		if (typeof source[field] !== "string")
			return invalid(`Option ${field} must be a string`);
	for (const field of booleanFields)
		if (typeof source[field] !== "boolean")
			return invalid(`Option ${field} must be a boolean`);
	if (
		!Number.isInteger(source.local_llm_context_size) ||
		Number(source.local_llm_context_size) < 1024 ||
		Number(source.local_llm_context_size) > 32768
	)
		return invalid("Option local_llm_context_size must be between 1024 and 32768");
	validateLocalModelUrl(String(source.local_llm_url));
	let managerUrl: URL;
	try {
		managerUrl = new URL(String(source.model_manager_url));
	} catch {
		return invalid("Option model_manager_url must be a valid URL");
	}
	if (
		managerUrl.protocol !== "http:" ||
		!["homeassistant", "localhost", "127.0.0.1"].includes(managerUrl.hostname)
	)
		return invalid("Option model_manager_url must target the local add-on network");
	if (source.pi_agent_webhook_url) {
		try {
			new URL(String(source.pi_agent_webhook_url));
		} catch {
			return invalid("Option pi_agent_webhook_url must be a valid URL");
		}
	}
	return source as unknown as AddonOptions;
}

export function publicAddonSettings(options: AddonOptions): PublicAddonSettings {
	return {
		discordTokenConfigured: Boolean(options.discord_token),
		ownerId: options.owner_id,
		piAgentWebhookUrl: options.pi_agent_webhook_url,
		localLlmEnabled: options.local_llm_enabled,
		localLlmUrl: options.local_llm_url,
		localLlmModel: options.local_llm_model,
		localLlmContextSize: options.local_llm_context_size,
		localLlmVision: options.local_llm_vision,
		modelManagerEnabled: options.model_manager_enabled,
		modelManagerUrl: options.model_manager_url,
		exaApiKeyConfigured: Boolean(options.exa_api_key),
		notifyTarget: options.ha_notify_target,
	};
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonical(entry)]),
		);
	return value;
}

export function settingsRevision(options: Record<string, unknown>): string {
	return createHash("sha256")
		.update(JSON.stringify(canonical(options)))
		.digest("hex");
}

const patchFields: Record<string, string> = {
	discordToken: "discord_token",
	ownerId: "owner_id",
	piAgentWebhookUrl: "pi_agent_webhook_url",
	localLlmEnabled: "local_llm_enabled",
	localLlmUrl: "local_llm_url",
	localLlmModel: "local_llm_model",
	localLlmContextSize: "local_llm_context_size",
	localLlmVision: "local_llm_vision",
	modelManagerEnabled: "model_manager_enabled",
	modelManagerUrl: "model_manager_url",
	exaApiKey: "exa_api_key",
	notifyTarget: "ha_notify_target",
};

export function applySettingsPatch(
	current: Record<string, unknown>,
	changes: unknown,
): Record<string, unknown> {
	if (!changes || typeof changes !== "object" || Array.isArray(changes))
		return invalid("Settings changes must be an object");
	const merged = { ...current };
	for (const [publicField, value] of Object.entries(
		changes as Record<string, unknown>,
	)) {
		const optionField = patchFields[publicField];
		if (!optionField) return invalid(`Unsupported settings field ${publicField}`);
		if (
			(publicField === "discordToken" || publicField === "exaApiKey") &&
			value === ""
		)
			continue;
		merged[optionField] =
			publicField === "notifyTarget" && typeof value === "string"
				? value.replace(/^notify\./, "")
				: value;
	}
	normalizeAddonOptions(merged);
	return merged;
}
