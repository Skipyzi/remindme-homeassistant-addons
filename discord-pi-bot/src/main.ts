import type { Embed } from "./assistant/embeds";
import type { PhoneButton } from "./phone/ha-app";
import type { EntryAction } from "./assistant/activity";
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
import { startReminders } from "./reminderSender";
import {
	activity,
	aiSettings,
	assistant,
	batteryButtons,
	batteryNeeds,
	confirmations,
	discordMessages,
	home,
	jobs,
	mailboxes,
	news,
	parcelSummary,
	phoneApp,
	setBriefSender,
	setOwnerNotifier,
	setJobNotifier,
	setDiscordBot,
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
	const messenger = startBot({ assistant, chats, confirmations, home, ownerId, activity });
	setDiscordBot(messenger);
	// Discord is one way out, wanted or not (Settings → Discord); the clock runs without it.
	const toDiscord = () => (messenger && discordMessages.on() ? messenger : undefined);
	startReminders({ ownerId, activity, phone: phoneApp, discord: messenger ? (reminder) => messenger.reminder(reminder) : undefined, discordWanted: discordMessages.on });

	// What RemindMe says first goes to every phone with the app, the RemindMe chat, and Discord when wanted.
	const notify = async (text: string, what: "brief" | "bins" | "battery" | "mail" | "heads_up" | "price" | "news" | "feed", extra?: { battery?: string; buttons?: PhoneButton[]; actions?: EntryAction[]; phoneTitle?: string; phoneBody?: string; embeds?: Embed[] }) => {
		const title = what === "brief" ? `☀️ ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}` : undefined;
		const discord = toDiscord();
		const [onDiscord, phones] = await Promise.all([
			discord ? discord.send(text, { title }) : Promise.resolve(false),
			// A tap opens RemindMe's own thread, where this message is, with its buttons.
			phoneApp.send({ title: extra?.phoneTitle || (what === "brief" ? "Morning brief" : what === "price" ? "Price drop" : what === "news" ? "News" : "RemindMe"), body: extra?.phoneBody || text, url: "./#t/remindme", tag: what === "price" ? `price-${Date.now()}` : what, ...(extra?.buttons ? { buttons: extra.buttons } : extra?.battery ? { buttons: batteryButtons(extra.battery) } : {}) }),
		]);
		// With Discord off, the RemindMe chat in the console is where it's delivered.
		const sent = onDiscord || phones > 0 || !discord;
		const actions = extra?.actions
			? extra.actions
			: extra?.battery
			? [
					{ label: "Remind me Saturday", kind: "battery-remind" as const, ref: extra.battery },
					{ label: "Got it", kind: "battery-hide" as const, ref: extra.battery },
				]
			: undefined;
		const channel = what === "brief" ? "brief" : what === "news" ? "news" : "nudge";
		activity.add(sent ? { kind: "sent", channel, text, ...(actions ? { actions } : {}), ...(extra?.embeds ? { embeds: extra.embeds } : {}) } : { kind: "failed", channel, text: `Couldn't send this to Discord or a phone: ${text}` });
		return sent;
	};
	// Always on: it does nothing until a mail connector is added in the console.
	const mail = new MailWatch({
		mailboxes,
		sorterUrl: process.env.INBOX_SORTER_URL ?? "http://local-inbox-sorter:8095",
		ask: (prompt) => assistant.quick(prompt),
		notify: (text) => notify(text, "mail"),
		onNew: (mails) => jobs.mailArrived(mails),
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
		batteries: batteryNeeds,
		options: {
			briefTime: process.env.MORNING_BRIEF_TIME ?? "07:00",
			binTime: process.env.BIN_REMINDER_TIME ?? "19:00",
			quietHours: process.env.QUIET_HOURS ?? "22:30-07:00",
			batteryThreshold: Number(process.env.BATTERY_NUDGE_PERCENT ?? 15) || 0,
			choresList: process.env.CHORES_LIST ?? "todo.chores",
		},
	});
	await proactive.load();
	// Price drops, the daily news and new posts go where the other nudges go: Discord, the phone and the RemindMe thread.
	setOwnerNotifier((text, extra) => notify(text, extra?.what || "price", extra));
	// A job's question or result comes as a DM card titled with the job; reply there or in the console.
	// The main chat and the phone get it on their own (with the job's cat and buttons); Discord only when wanted.
	setJobNotifier(async (thread, text) => {
		const discord = toDiscord();
		if (!discord) return;
		const sent = await discord.send(`${text}\n\n_Reply here or in the RemindMe console._`, { title: thread.title });
		if (!sent) activity.add({ kind: "failed", channel: "job", text: `Couldn't send this on Discord: ${thread.title}: ${text}` });
	});
	// The brief and nudges run with or without Discord: the phone and the RemindMe chat get them.
	proactive.start();
	setBriefSender(() => proactive.sendBrief());
	setPlannedSends(async () => [...(await proactive.upcoming()), ...news.upcoming()].sort((a, b) => a.at.getTime() - b.at.getTime()));
	if (!messenger) console.log("No Discord bot: the brief, reminders and nudges go to the phone and the RemindMe chat.");
}

main().catch((error: Error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
