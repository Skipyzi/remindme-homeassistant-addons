export type ThinkingMode = "fast" | "balanced" | "deep" | "research";

export interface ThinkingProfile {
	id: ThinkingMode;
	name: string;
	reasoningBudget: number;
	answerReserve: number;
	maxTokens: number;
	description: string;
	estimatedMaxSeconds: number;
	recommended: boolean;
}

function profile(
	id: ThinkingMode,
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
			"fast",
			"Fast",
			0,
			512,
			"No visible reasoning. Best for chat and direct commands.",
			decodeTokensPerSecond,
		),
		profile(
			"balanced",
			"Balanced",
			384,
			768,
			"Short reasoning with enough space reserved for a complete answer.",
			decodeTokensPerSecond,
			true,
		),
		profile(
			"deep",
			"Deep",
			1024,
			1024,
			"Longer reasoning for planning and difficult questions.",
			decodeTokensPerSecond,
		),
	];
	if (totalMemoryBytes >= 7 * 1_073_741_824 && contextSize >= 8192) {
		profiles.push(
			profile(
				"research",
				"Research",
				2048,
				1536,
				"Extended reasoning for complex comparisons. Slow on Raspberry Pi 5.",
				decodeTokensPerSecond,
			),
		);
	}
	return profiles;
}

export function getThinkingProfile(
	mode: string,
	totalMemoryBytes: number,
	contextSize: number,
): ThinkingProfile {
	const profiles = thinkingProfilesForHardware(totalMemoryBytes, contextSize);
	return profiles.find((item) => item.id === mode) || profiles[0];
}
