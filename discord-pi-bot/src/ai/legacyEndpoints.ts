import { readFileSync } from "node:fs";

interface StoredEndpoint {
	url?: string;
	model?: string;
	apiKey?: string;
	authProvider?: string;
}

/** The key options RemindMe 3.x's saved endpoints can fill. */
export interface LegacyKeys {
	ANTHROPIC_API_KEY?: string;
	OPENAI_API_KEY?: string;
	/** The model last picked for the ChatGPT sign-in. */
	CHATGPT_MODEL?: string;
}

/**
 * RemindMe 3.x kept API keys in a list of endpoints in /data. Read them so an
 * upgrade keeps working before the keys are moved into the app options;
 * options always win. Subscription endpoints carry no key and are skipped,
 * and so are servers RemindMe no longer talks to (local llama.cpp,
 * OpenCode, other OpenAI-compatible ones).
 */
export function legacyKeys(path: string | undefined): LegacyKeys {
	if (!path) return {};
	let endpoints: StoredEndpoint[] = [];
	try {
		const stored = JSON.parse(readFileSync(path, "utf8")) as { endpoints?: StoredEndpoint[] };
		endpoints = Array.isArray(stored.endpoints) ? stored.endpoints : [];
	} catch {
		return {};
	}
	const keys: LegacyKeys = {};
	for (const endpoint of endpoints) {
		if (endpoint.authProvider === "chatgpt" && typeof endpoint.model === "string") keys.CHATGPT_MODEL ||= endpoint.model || undefined;
		if (endpoint.authProvider || typeof endpoint.url !== "string") continue;
		let url: URL;
		try {
			url = new URL(endpoint.url);
		} catch {
			continue;
		}
		const key = typeof endpoint.apiKey === "string" ? endpoint.apiKey : "";
		if (url.hostname === "api.anthropic.com") keys.ANTHROPIC_API_KEY ||= key || undefined;
		else if (url.hostname === "api.openai.com") keys.OPENAI_API_KEY ||= key || undefined;
	}
	return keys;
}

/** The environment with 3.x keys filled in wherever an option is blank. */
export function withLegacyKeys(env: NodeJS.ProcessEnv, path = env.LEGACY_ENDPOINTS_PATH): NodeJS.ProcessEnv {
	const legacy = legacyKeys(path);
	const merged: NodeJS.ProcessEnv = { ...env };
	for (const [name, value] of Object.entries(legacy)) if (value && !merged[name]) merged[name] = value;
	return merged;
}
