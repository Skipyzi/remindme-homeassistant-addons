export interface HardwareProfile {
	name: string;
	contextSize: number;
	batchSize: number;
	threads: number;
	flashAttention: boolean;
	kvCache: "q8_0" | "f16";
}

export function validateLocalModelUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Model endpoint must be a valid URL");
	}
	if (url.protocol !== "http:")
		throw new Error("Model endpoint must use internal HTTP");
	if (!["homeassistant", "localhost", "127.0.0.1"].includes(url.hostname))
		throw new Error("Model endpoint must target the local add-on network");
	return url.toString();
}

export function recommendHardwareProfile(
	totalMemoryBytes: number,
	cpuCores: number,
): HardwareProfile {
	const memoryGb = totalMemoryBytes / 1_073_741_824;
	if (memoryGb >= 7)
		return {
			name: "Balanced house",
			contextSize: 8192,
			batchSize: 256,
			threads: Math.min(4, cpuCores),
			flashAttention: true,
			kvCache: "q8_0",
		};
	return {
		name: "Compact house",
		contextSize: 4096,
		batchSize: 128,
		threads: Math.min(4, cpuCores),
		flashAttention: true,
		kvCache: "q8_0",
	};
}

export function publicSettings(environment: NodeJS.ProcessEnv) {
	return {
		localLlmUrl:
			environment.LOCAL_LLM_URL ||
			"http://homeassistant:8080/v1/chat/completions",
		model: environment.LOCAL_LLM_MODEL || "qwen3-1.7b",
		modelManagerEnabled: environment.MODEL_MANAGER_ENABLED === "true",
		exaConfigured: Boolean(environment.EXA_API_KEY),
		notifyTarget: environment.HA_NOTIFY_TARGET || "",
	};
}

export function mergeAddonOptions(
	supervisorResponse: unknown,
	updates: Record<string, unknown>,
): Record<string, unknown> {
	if (!supervisorResponse || typeof supervisorResponse !== "object")
		throw new Error("Unable to read current add-on options from Supervisor");
	const data = (supervisorResponse as { data?: unknown }).data;
	if (!data || typeof data !== "object")
		throw new Error("Unable to read current add-on options from Supervisor");
	const options = (data as { options?: unknown }).options;
	if (!options || typeof options !== "object" || Array.isArray(options))
		throw new Error("Unable to read current add-on options from Supervisor");
	return { ...(options as Record<string, unknown>), ...updates };
}
