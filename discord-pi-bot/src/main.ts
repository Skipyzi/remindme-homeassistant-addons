import "dotenv/config";
import { startBot } from "./bot";
import { setReminderAi } from "./commands/remind";
import { DiscordChats } from "./discord/chats";
import { Proactive } from "./assistant/proactive";
import { setAiReadiness } from "./presence";
import { listReminders } from "./utils/reminderManager";
import {
	activity,
	aiSettings,
	assistant,
	confirmations,
	home,
	parcelSummary,
	setBriefSender,
	setPlannedSends,
	startHarness,
} from "./harness-server";

/**
 * RemindMe in one process: the console, the Discord bot, and the assistant
 * that speaks first. They share one assistant, one set of confirmations, and
 * one Home Assistant connection.
 */
async function main() {
	await startHarness();
	setReminderAi((prompt) => assistant.quick(prompt));
	setAiReadiness(async () => aiSettings.status(false).ready);

	const chats = new DiscordChats();
	await chats.load();
	const ownerId = process.env.OWNER_ID || "";
	const messenger = startBot({ assistant, chats, confirmations, home, ownerId, activity });

	const proactive = new Proactive({
		assistant,
		home,
		notify: async (text, what) => {
			const sent = messenger ? await messenger.send(text) : false;
			activity.add(
				sent
					? { kind: "sent", channel: what === "brief" ? "brief" : "nudge", text }
					: { kind: "failed", channel: what === "brief" ? "brief" : "nudge", text: `Couldn't send this on Discord: ${text}` },
			);
			return sent;
		},
		reminders: () => listReminders(ownerId),
		parcels: parcelSummary,
		options: {
			briefTime: process.env.MORNING_BRIEF_TIME ?? "07:00",
			binTime: process.env.BIN_REMINDER_TIME ?? "19:00",
			quietHours: process.env.QUIET_HOURS ?? "22:30-07:00",
			batteryThreshold: Number(process.env.BATTERY_NUDGE_PERCENT ?? 15) || 0,
		},
	});
	await proactive.load();
	if (messenger) {
		proactive.start();
		setBriefSender(() => proactive.sendBrief());
		setPlannedSends(() => proactive.upcoming());
	} else console.log("No Discord bot: the morning brief and nudges are off.");
}

main().catch((error: Error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
