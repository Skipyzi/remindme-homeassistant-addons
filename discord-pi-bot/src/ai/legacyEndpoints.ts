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
	OPENCODE_API_KEY?: string;
	CUSTOM_AI_URL?: string;
	CUSTOM_AI_KEY?: string;
	/** The model last picked for the ChatGPT sign-in. */
	CHATGPT_MODEL?: string;
}

/* The local llama.cpp app RemindMe 4 no longer uses. */
const LOCAL_LLAMA = /^(homeassistant|localhost|127\.0\.0\.1|local-llama-cpp)$/;

/**
 * RemindMe 3.x kept API keys in a list of endpoints in /data. Read them so an
 * upgrade keeps working before the keys are moved into the app options;
 * options always win. Subscription endpoints carry no key and are skipped.
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
		else if (url.hostname === "opencode.ai") keys.OPENCODE_API_KEY ||= key || undefined;
		else if (!LOCAL_LLAMA.test(url.hostname) && !keys.CUSTOM_AI_URL) {
			// The base URL, without the endpoint path 3.x stored.
			keys.CUSTOM_AI_URL = endpoint.url.replace(/\/(chat\/completions|responses|messages)\/?$/, "");
			if (key) keys.CUSTOM_AI_KEY = key;
		}
	}
	return keys;
}

/** The environment with 3.x keys filled in wherever an option is blank. */
export function withLegacyKeys(env: NodeJS.ProcessEnv, path = env.LEGACY_ENDPOINTS_PATH): NodeJS.ProcessEnv {
	const legacy = legacyKeys(path);
	const merged: NodeJS.ProcessEnv = { ...env };
	// A custom server set in the options keeps its own key, blank or not.
	if (env.CUSTOM_AI_URL) {
		delete legacy.CUSTOM_AI_URL;
		delete legacy.CUSTOM_AI_KEY;
	}
	for (const [name, value] of Object.entries(legacy)) if (value && !merged[name]) merged[name] = value;
	return merged;
}
