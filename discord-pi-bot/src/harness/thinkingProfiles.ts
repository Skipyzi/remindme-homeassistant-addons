export type ReasoningEffort = "none" | "low" | "medium" | "high";
/** Legacy IDs remain accepted for existing API clients and saved settings. */
export type ThinkingMode = ReasoningEffort | "fast" | "balanced" | "deep" | "research";

export function normalizeEffort(mode: string): ReasoningEffort {
	const aliases: Record<string, ReasoningEffort> = { fast: "none", balanced: "low", deep: "medium", research: "high" };
	return Object.prototype.hasOwnProperty.call(aliases, mode) ? aliases[mode] : (["none", "low", "medium", "high"].includes(mode) ? mode as ReasoningEffort : "none");
}

export function effortForBudget(thinking: boolean, budget = 0): ReasoningEffort {
	return !thinking ? "none" : budget >= 4096 ? "high" : budget >= 2048 ? "medium" : "low";
}

export interface EffortBackend {
	openaiCompat: boolean;
	authProvider?: "chatgpt" | "claude";
	model: string;
}

export interface ThinkingProfile {
	id: ReasoningEffort;
	name: string;
	reasoningBudget: number;
	answerReserve: number;
	maxTokens: number;
	description: string;
	estimatedMaxSeconds: number;
	recommended: boolean;
}

function profile(
	id: ReasoningEffort,
	name: string,
	reasoningBudget: number,
	answerReserve: number,
	description: string,
	decodeTokensPerSecond: number,
	recommended = false,
): ThinkingProfile {
	return {
		id,
		name,
		reasoningBudget,
		answerReserve,
		maxTokens: reasoningBudget + answerReserve,
		description,
		estimatedMaxSeconds: Math.ceil(
			reasoningBudget / Math.max(1, decodeTokensPerSecond),
		),
		recommended,
	};
}

export function thinkingProfilesForHardware(
	totalMemoryBytes: number,
	contextSize: number,
	decodeTokensPerSecond = 7,
): ThinkingProfile[] {
	const profiles = [
		profile(
			"none",
			"None",
			0,
			1024,
			"No visible reasoning. Best for chat and direct commands.",
			decodeTokensPerSecond,
		),
		profile(
			"low",
			"Low",
			512,
			1536,
			"Short reasoning with enough space reserved for a complete answer.",
			decodeTokensPerSecond,
			true,
		),
		profile(
			"medium",
			"Medium",
			2048,
			2048,
			"Longer reasoning for planning and difficult questions.",
			decodeTokensPerSecond,
		),
	];
	if (totalMemoryBytes >= 7 * 1_073_741_824 && contextSize >= 8192) {
		profiles.push(
			profile(
				"high",
				"High",
				4096,
				1536,
				"Extended reasoning for complex comparisons. Slow on Raspberry Pi 5.",
				decodeTokensPerSecond,
			),
		);
	}
	return profiles;
}

/** Cloud inference is not constrained by the Pi's local decoding budget. */
export function thinkingProfilesForBackend(
	totalMemoryBytes: number,
	contextSize: number,
	backend?: EffortBackend,
): ThinkingProfile[] {
	if (!backend?.openaiCompat) return thinkingProfilesForHardware(totalMemoryBytes, contextSize);
	const profiles = thinkingProfilesForHardware(8 * 1_073_741_824, 8192);
	const minimumLow = backend.authProvider === "claude" || /^(gpt-6-astra|gpt-6\.1-sol)(-|$)/.test(backend.model);
	return profiles.filter((item) => !minimumLow || item.id !== "none").map((item) => ({
		...item,
		estimatedMaxSeconds: 0,
		description: {
			none: "No reasoning requested. Best for quick replies.",
			low: "Light reasoning for quick replies and routine tasks.",
			medium: "Moderate reasoning for planning and difficult questions.",
			high: "More reasoning for complex questions, with a longer wait.",
		}[item.id],
	}));
}

export function getThinkingProfile(
	mode: string,
	totalMemoryBytes: number,
	contextSize: number,
	backend?: EffortBackend,
): ThinkingProfile {
	const profiles = thinkingProfilesForBackend(totalMemoryBytes, contextSize, backend);
	return profiles.find((item) => item.id === normalizeEffort(mode)) || profiles[0];
}
