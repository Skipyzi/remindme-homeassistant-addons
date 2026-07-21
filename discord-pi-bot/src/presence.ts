import { ActivityType, type Client } from "discord.js";
import { config } from "./config";
import {
	PresenceUptimeTracker,
	type UptimeSnapshot,
} from "./presenceUptime";
import { countReminders } from "./utils/reminderManager";

const CHECK_INTERVAL_MS = 60_000;
let bridgeUrl: URL | undefined;
if (config.webhookUrl) {
	try {
		const parsed = new URL(config.webhookUrl);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
			throw new Error("PI_AGENT_WEBHOOK_URL must use HTTP or HTTPS");
		bridgeUrl = parsed;
	} catch (error) {
		console.error(
			"Invalid PI_AGENT_WEBHOOK_URL; presence monitoring disabled:",
			error,
		);
	}
}

async function piAgentIsReachable(): Promise<boolean> {
	if (!bridgeUrl) return false;
	try {
		const response = await fetch(bridgeUrl, {
			method: "GET",
			signal: AbortSignal.timeout(5_000),
		});
		return response.ok || response.status < 500;
	} catch {
		return false;
	}
}

interface UptimeTrackerLike {
	initialize(): Promise<UptimeSnapshot>;
	sample(): Promise<UptimeSnapshot>;
}

interface PresenceMonitorDependencies {
	tracker?: UptimeTrackerLike;
	reachable?: () => Promise<boolean>;
	reminderCount?: () => number | Promise<number>;
	schedule?: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
}

export function formatPresenceDuration(totalOnlineMs: number): string {
	const totalMinutes = Math.max(0, Math.floor(totalOnlineMs / 60_000));
	const days = Math.floor(totalMinutes / (24 * 60));
	const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

export function formatPresenceActivity(
	connected: boolean,
	snapshot: UptimeSnapshot,
	reminderCount: number,
): { name: string; state: string } {
	const rawAvailability = Number.isFinite(snapshot.availabilityPercent)
		? snapshot.availabilityPercent
		: 0;
	const availability = Math.min(100, Math.max(0, rawAvailability)).toFixed(2);
	const count = Number.isFinite(reminderCount)
		? Math.max(0, Math.floor(reminderCount))
		: 0;
	return {
		name: `RemindMe • ${connected ? "Pi connected" : "Pi offline"}`,
		state: `Up ${formatPresenceDuration(snapshot.totalOnlineMs)} • ${availability}% • ${count} ${count === 1 ? "reminder" : "reminders"}`,
	};
}

export async function updatePresence(
	client: Client,
	snapshot: UptimeSnapshot,
	reachable: () => Promise<boolean> = piAgentIsReachable,
	reminderCount: () => number | Promise<number> = () => {
		const ownerId = process.env.OWNER_ID || "";
		return ownerId ? countReminders(ownerId) : 0;
	},
): Promise<void> {
	const connected = await reachable();
	let count = 0;
	try {
		count = await reminderCount();
	} catch {
		console.error("Presence reminder count failed; using zero.");
	}
	const activity = formatPresenceActivity(connected, snapshot, count);
	client.user?.setPresence({
		status: connected ? "online" : "idle",
		activities: [
			{
				name: activity.name,
				type: ActivityType.Watching,
				state: activity.state,
			},
		],
	});
}

function processUptimeSnapshot(): UptimeSnapshot {
	const totalOnlineMs = Math.max(0, process.uptime() * 1_000);
	const now = Date.now();
	return {
		totalOnlineMs,
		availabilityPercent: 100,
		trackingStartedAt: now - totalOnlineMs,
		lastHeartbeatAt: now,
	};
}

export async function startPresenceMonitor(
	client: Client,
	dependencies: PresenceMonitorDependencies = {},
): Promise<NodeJS.Timeout> {
	const tracker =
		dependencies.tracker ||
		new PresenceUptimeTracker(
			process.env.PRESENCE_UPTIME_PATH || "/data/presence-uptime.json",
			{
				logError: (message) => console.error(message),
			},
		);
	const reachable = dependencies.reachable || piAgentIsReachable;
	const reminderCount = dependencies.reminderCount;
	const schedule = dependencies.schedule || setInterval;
	let running = false;

	const tick = async (initial?: UptimeSnapshot): Promise<void> => {
		if (running) return;
		running = true;
		try {
			let snapshot = initial;
			if (!snapshot) {
				try {
					snapshot = await tracker.sample();
				} catch {
					console.error("Presence uptime sampling failed; using process uptime.");
					snapshot = processUptimeSnapshot();
				}
			}
			await updatePresence(client, snapshot, reachable, reminderCount);
		} finally {
			running = false;
		}
	};

	let initial: UptimeSnapshot;
	try {
		initial = await tracker.initialize();
	} catch {
		console.error("Presence uptime initialization failed; using process uptime.");
		initial = processUptimeSnapshot();
	}
	await tick(initial);
	return schedule(() => void tick(), CHECK_INTERVAL_MS);
}
