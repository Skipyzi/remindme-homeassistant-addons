/** A "#rrggbb" or "rrggbb" hex string to an embed colour int; blurple default. */
function parseColor(value: string | undefined): number {
	const hex = (value || "").replace(/^#/, "").trim();
	const parsed = Number.parseInt(hex, 16);
	return /^[0-9a-f]{6}$/i.test(hex) && !Number.isNaN(parsed)
		? parsed
		: 0x5865f2;
}

export const config = {
	token: process.env.DISCORD_BOT_TOKEN || "",
	ownerId: process.env.OWNER_ID || "",
	/* Register slash commands to this one server for instant availability;
	 * blank falls back to global registration (up to ~1h to propagate). */
	guildId: process.env.DISCORD_GUILD_ID || "",
	/* Show surreal, random placeholder text while a slash command is working
	 * (e.g. "Pondering your choices…"). Default on; set false for plain text. */
	playfulPlaceholders: process.env.PLAYFUL_PLACEHOLDERS !== "false",
	/* Accent colour of the reminder card, as a hex string in add-on config. */
	reminderColor: parseColor(process.env.REMINDER_COLOR),
	aiApiKey: process.env.OPENAI_API_KEY || "",
	aiModel: process.env.AI_MODEL || "gpt-3.5-turbo",
	aiSystemPrompt:
		process.env.AI_SYSTEM_PROMPT || "You are a helpful AI assistant.",
	chatPrefix: process.env.CHAT_PREFIX || "!chat",
	webhookUrl: process.env.PI_AGENT_WEBHOOK_URL || "",
	localLlmEnabled: process.env.LOCAL_LLM_ENABLED === "true",
	localLlmUrl:
		process.env.LOCAL_LLM_URL ||
		"http://local-llama-cpp:8080/v1/chat/completions",
	localLlmModel: process.env.LOCAL_LLM_MODEL || "qwen3-1.7b",
	localLlmTimeoutMs: Number(process.env.LOCAL_LLM_TIMEOUT_MS || 30000),
	reminderCheckInterval: parseInt(
		process.env.REMINDER_CHECK_INTERVAL || "60000",
		10,
	),
	trackingMoreApiKey: process.env.TRACKINGMORE_API_KEY || "",
};

export function validateConfig(): string[] {
	const errors: string[] = [];
	if (!config.token) errors.push("Missing DISCORD_BOT_TOKEN in environment");
	if (!config.ownerId) errors.push("Missing OWNER_ID in environment");
	if (!config.webhookUrl)
		errors.push("Missing PI_AGENT_WEBHOOK_URL in environment");
	return errors;
}
