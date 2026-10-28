import "dotenv/config";
import { startBot } from "./bot";
import { setReminderAi } from "./commands/remind";
import { DiscordChats } from "./discord/chats";
import { Proactive } from "./assistant/proactive";
import { MailWatch } from "./mail/watch";
import { Triage, houseConcerns, newMail, soonEvents, stuckJobs, type Candidate } from "./assistant/triage";
import { wasteEvents } from "./assistant/proactive";
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
	phoneApp,
	setBriefSender,
	setJobNotifier,
	setPlannedSends,
	startHarness,
	threads,
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
	const messenger = startBot({ assistant, chats, confirmations, home, ownerId, activity, phone: phoneApp });

	// What RemindMe says first goes to Discord and to every phone with the app.
	const notify = async (text: string, what: "brief" | "bins" | "battery" | "mail" | "heads_up") => {
		const title = what === "brief" ? `☀️ ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}` : undefined;
		const [onDiscord, phones] = await Promise.all([
			messenger ? messenger.send(text, { title }) : Promise.resolve(false),
			phoneApp.send({ title: what === "brief" ? "Morning brief" : "RemindMe", body: text, url: "./", tag: what }),
		]);
		const sent = onDiscord || phones > 0;
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
	// A few times a day: is there anything across mail, calendar, house and jobs worth a heads-up?
	const triage =
		process.env.SMART_NUDGES === "false"
			? undefined
			: new Triage({
					gather: async (now, since) => {
						const candidates: Candidate[] = [];
						if (home) {
							const [cards, events] = await Promise.all([
								home.cards().catch(() => []),
								home.calendarEvents(now, new Date(now.getTime() + 3 * 3_600_000)).catch(() => []),
							]);
							const waste = new Set(wasteEvents(events));
							candidates.push(...houseConcerns(cards, now), ...soonEvents(events.filter((event) => !waste.has(event) && Date.parse(event.start) > now.getTime())));
						}
						candidates.push(...newMail(mail.digest(), since), ...stuckJobs(threads.list(), now));
						return candidates;
					},
					ask: (prompt) => assistant.quick(prompt),
					notify: (text) => notify(text, "heads_up"),
				});
	await triage?.load();
	const proactive = new Proactive({
		assistant,
		home,
		mail,
		triage,
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
	// A job's question or result comes as a DM card titled with the job; reply there or in the console.
	setJobNotifier(async (thread, text) => {
		const sent = messenger ? await messenger.send(`${text}\n\n_Reply here or in the RemindMe console._`, { title: thread.title }) : false;
		activity.add(sent ? { kind: "sent", channel: "job", text: `${thread.title}: ${text}` } : { kind: "failed", channel: "job", text: `Couldn't send this on Discord: ${thread.title}: ${text}` });
	});
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
