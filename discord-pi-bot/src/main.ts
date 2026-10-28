import "dotenv/config";
import { startBot } from "./bot";
import { setReminderAi } from "./commands/remind";
import { DiscordChats } from "./discord/chats";
import { Proactive } from "./assistant/proactive";
import { MailWatch } from "./mail/watch";
import { setAiReadiness } from "./presence";
import { listReminders } from "./utils/reminderManager";
import {
	activity,
	aiSettings,
	assistant,
	confirmations,
	home,
	mailboxes,
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

	const notify = async (text: string, what: "brief" | "bins" | "battery" | "mail") => {
		const title = what === "brief" ? `☀️ ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}` : undefined;
		const sent = messenger ? await messenger.send(text, { title }) : false;
		activity.add(
			sent
				? { kind: "sent", channel: what === "brief" ? "brief" : "nudge", text }
				: { kind: "failed", channel: what === "brief" ? "brief" : "nudge", text: `Couldn't send this on Discord: ${text}` },
		);
		return sent;
	};
	// Always on: it does nothing until a mail connector is added in the console.
	const mail = new MailWatch({
		mailboxes,
		sorterUrl: process.env.INBOX_SORTER_URL ?? "http://local-inbox-sorter:8095",
		ask: (prompt) => assistant.quick(prompt),
		notify: (text) => notify(text, "mail"),
		nudges: process.env.MAIL_NUDGES !== "false",
	});
	await mail.load();
	const proactive = new Proactive({
		assistant,
		home,
		mail,
		notify,
		reminders: () => listReminders(ownerId),
		did: (text) => activity.add({ kind: "did", channel: "nudge", text, receipts: [{ text }] }),
		parcels: parcelSummary,
		options: {
			briefTime: process.env.MORNING_BRIEF_TIME ?? "07:00",
			binTime: process.env.BIN_REMINDER_TIME ?? "19:00",
			quietHours: process.env.QUIET_HOURS ?? "22:30-07:00",
			batteryThreshold: Number(process.env.BATTERY_NUDGE_PERCENT ?? 15) || 0,
			choresList: process.env.CHORES_LIST ?? "todo.chores",
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
