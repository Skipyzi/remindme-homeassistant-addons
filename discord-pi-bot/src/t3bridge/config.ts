/**
 * The T3 Code bridge's settings, from the app options (run.sh exports them).
 * The bridge is off unless both the MCP URL and the token are set, so the
 * bot works as before without them.
 */

/** Voxel Breach in T3 Code on Gabor's PC. */
export const VOXEL_BREACH_PROJECT = "d046b1ba-bd82-49d1-9662-446a790a285b";
export const DEFAULT_CHANNELS = `suggestions=${VOXEL_BREACH_PROJECT}`;
export const DEFAULT_MODEL = "claudeAgent/claude-opus-5-5";
export const DEFAULT_BASE_REF = "origin/main";

export interface ChannelRoute {
	projectId: string;
	/** The branch a new worktree starts from, as `remote/branch`. */
	baseRef: string;
}

export interface BridgeConfig {
	url: string;
	token: string;
	/** The one server the bridge answers in. */
	guildId: string;
	ownerId: string;
	/** Who may start and drive T3 threads; the owner is always one of them. */
	allowedUsers: string[];
	/** Forum or text channel → project. Keys are channel ids, or lower-case names (only with a guild id set). */
	channels: Map<string, ChannelRoute>;
	pollMs: number;
	queueTimeoutMs: number;
	/** T3 launches and sends a day, across everyone. */
	dailyLimit: number;
	/** Longer answers are summarised (or cut) with a link to the full one in T3. */
	maxPostChars: number;
	model: { instanceId: string; model: string };
	dataPath: string;
}

export type BridgeSetup = { on: true; config: BridgeConfig; warnings: string[] } | { on: false; reason: string };

function ids(value: string | undefined): string[] {
	return (value || "")
		.split(/[\s,;]+/)
		.map((part) => part.trim())
		.filter((part) => /^\d{5,25}$/.test(part));
}

function number(value: string | undefined, fallback: number, min: number, max: number): number {
	const parsed = Number(value);
	if (!value || !Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

const PROJECT_ID = /^[\w-]{8,80}$/;

/**
 * "123456789012345678=<project id>, suggestions=<project id>@origin/main":
 * a channel id (or, inside the configured server, a channel name) to a T3
 * project, optionally with the branch new worktrees start from.
 */
export function parseChannels(value: string, baseRef: string, hasGuild: boolean, warnings: string[] = []): Map<string, ChannelRoute> {
	const routes = new Map<string, ChannelRoute>();
	for (const entry of value.split(/[,;\n]+/)) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const match = /^#?([^=\s]+)\s*=\s*([^@\s]+)(?:@(\S+))?$/.exec(trimmed);
		if (!match || !PROJECT_ID.test(match[2])) {
			warnings.push(`t3_channels: can't read "${trimmed.slice(0, 60)}"`);
			continue;
		}
		const key = match[1].toLowerCase();
		const byName = !/^\d{5,25}$/.test(key);
		// A name is only safe to trust inside one known server.
		if (byName && !hasGuild) {
			warnings.push(`t3_channels: "${key}" is a channel name; set t3_guild_id (or guild_id) or use the channel's id`);
			continue;
		}
		routes.set(key, { projectId: match[2], baseRef: match[3] || baseRef });
	}
	return routes;
}

/** "claudeAgent/claude-opus-5-5": a T3 provider instance and one of its models. */
export function parseModel(value: string | undefined): { instanceId: string; model: string } {
	const text = (value || "").trim() || DEFAULT_MODEL;
	const slash = text.indexOf("/");
	if (slash <= 0 || slash === text.length - 1) return parseModel(DEFAULT_MODEL);
	return { instanceId: text.slice(0, slash), model: text.slice(slash + 1) };
}

export function bridgeSetup(env: NodeJS.ProcessEnv = process.env): BridgeSetup {
	const url = (env.T3_MCP_URL || "").trim();
	const token = (env.T3_TOKEN || "").trim();
	if (!url || !token) return { on: false, reason: "t3_mcp_url and t3_token are not both set" };
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocol");
	} catch {
		return { on: false, reason: "t3_mcp_url is not an http(s) URL" };
	}
	const ownerId = (env.OWNER_ID || "").trim();
	if (!ownerId) return { on: false, reason: "no owner_id" };
	const warnings: string[] = [];
	const guildId = ids(env.T3_GUILD_ID)[0] || ids(env.DISCORD_GUILD_ID)[0] || "";
	const baseRef = (env.T3_BASE_REF || "").trim() || DEFAULT_BASE_REF;
	const channels = parseChannels(env.T3_CHANNELS?.trim() || DEFAULT_CHANNELS, baseRef, Boolean(guildId), warnings);
	if (!channels.size) return { on: false, reason: `no usable t3_channels${warnings.length ? ` (${warnings.join("; ")})` : ""}` };
	const allowed = new Set([ownerId, ...ids(env.T3_ALLOWED_USERS)]);
	return {
		on: true,
		warnings,
		config: {
			url,
			token,
			guildId,
			ownerId,
			allowedUsers: [...allowed],
			channels,
			pollMs: number(env.T3_POLL_SECONDS, 20, 5, 600) * 1000,
			queueTimeoutMs: number(env.T3_QUEUE_HOURS, 12, 0.1, 168) * 3_600_000,
			dailyLimit: Math.round(number(env.T3_DAILY_LIMIT, 20, 1, 500)),
			maxPostChars: Math.round(number(env.T3_MAX_POST_CHARS, 3500, 500, 20_000)),
			model: parseModel(env.T3_MODEL),
			dataPath: env.T3_BRIDGE_PATH || "./data/t3-bridge.json",
		},
	};
}
