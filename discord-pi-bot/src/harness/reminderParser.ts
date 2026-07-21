/**
 * Turn "remind me to check the mail at 5" into a time and a message.
 *
 * Parsed deterministically rather than by asking the model. A 1.7B model on a
 * Pi is unreliable at date arithmetic and would spend a second turn getting it
 * wrong; the phrasings people actually use are a short list. Anything not on
 * that list returns no time, and the caller asks rather than guessing.
 */

export interface ParsedReminder {
	/** What to say when it fires. */
	message: string;
	/** When, or undefined when the text carried no usable time. */
	at?: Date;
	/** The phrase the time came from, for the confirmation card. */
	matched?: string;
	/** True when a bare hour was read as PM rather than AM. */
	assumedEvening?: boolean;
}

const WEEKDAYS = [
	"sunday",
	"monday",
	"tuesday",
	"wednesday",
	"thursday",
	"friday",
	"saturday",
];

function stripLead(text: string): string {
	return text
		.replace(/^\s*(?:please\s+)?remind\s+me\s+(?:to\s+|that\s+|about\s+)?/i, "")
		.replace(/^\s*(?:set\s+a\s+reminder\s+(?:to\s+|for\s+)?)/i, "")
		.trim();
}

function withTime(base: Date, hours: number, minutes: number): Date {
	const date = new Date(base);
	date.setHours(hours, minutes, 0, 0);
	return date;
}

/**
 * Resolve a bare hour. "at 5" means 17:00 far more often than 05:00, so an
 * unqualified 1-11 is read as the next occurrence, preferring the evening
 * when both are still ahead.
 */
function resolveBareHour(now: Date, hour: number, minutes: number) {
	if (hour === 0 || hour > 12) return { date: withTime(now, hour, minutes) };
	const morning = withTime(now, hour === 12 ? 0 : hour, minutes);
	const evening = withTime(now, hour === 12 ? 12 : hour + 12, minutes);
	if (evening > now) return { date: evening, assumedEvening: hour <= 11 };
	if (morning > now) return { date: morning };
	// Both gone today: same hour tomorrow, evening reading kept.
	const tomorrow = new Date(evening);
	tomorrow.setDate(tomorrow.getDate() + 1);
	return { date: tomorrow, assumedEvening: hour <= 11 };
}

export function parseReminder(input: string, now = new Date()): ParsedReminder {
	const original = String(input || "").trim();
	let text = stripLead(original);
	let at: Date | undefined;
	let matched: string | undefined;
	let assumedEvening = false;

	const take = (pattern: RegExp, build: (m: RegExpMatchArray) => Date | undefined) => {
		if (at) return;
		const found = text.match(pattern);
		if (!found) return;
		const date = build(found);
		if (!date || Number.isNaN(date.getTime())) return;
		at = date;
		matched = found[0].trim();
		text = (text.slice(0, found.index) + text.slice((found.index || 0) + found[0].length))
			.replace(/\s{2,}/g, " ")
			.trim();
	};

	// "in 10 minutes", "in 2h"
	take(
		/\bin\s+(\d+)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i,
		(found) => {
			const amount = Number(found[1]);
			const unit = found[2].toLowerCase();
			const date = new Date(now);
			if (unit.startsWith("d")) date.setDate(date.getDate() + amount);
			else if (unit.startsWith("h")) date.setMinutes(date.getMinutes() + amount * 60);
			else date.setMinutes(date.getMinutes() + amount);
			return date;
		},
	);

	// "tomorrow at 9", "tomorrow morning"
	take(
		/\btomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i,
		(found) => {
			const date = new Date(now);
			date.setDate(date.getDate() + 1);
			if (!found[1]) return withTime(date, 9, 0);
			let hour = Number(found[1]);
			const minutes = Number(found[2] || 0);
			const suffix = found[3]?.toLowerCase();
			if (suffix === "pm" && hour < 12) hour += 12;
			if (suffix === "am" && hour === 12) hour = 0;
			if (!suffix && hour <= 11) {
				hour += 12;
				assumedEvening = true;
			}
			return withTime(date, hour, minutes);
		},
	);

	// "on friday at 9", "friday"
	take(
		new RegExp(`\\b(?:on\\s+)?(${WEEKDAYS.join("|")})(?:\\s+(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?`, "i"),
		(found) => {
			const target = WEEKDAYS.indexOf(found[1].toLowerCase());
			const date = new Date(now);
			// Always the next such day, never today.
			const delta = (target - date.getDay() + 7) % 7 || 7;
			date.setDate(date.getDate() + delta);
			if (!found[2]) return withTime(date, 9, 0);
			let hour = Number(found[2]);
			const minutes = Number(found[3] || 0);
			const suffix = found[4]?.toLowerCase();
			if (suffix === "pm" && hour < 12) hour += 12;
			if (suffix === "am" && hour === 12) hour = 0;
			if (!suffix && hour <= 11) {
				hour += 12;
				assumedEvening = true;
			}
			return withTime(date, hour, minutes);
		},
	);

	// "tonight at 8", "this evening"
	take(/\b(?:tonight|this evening)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?)?/i, (found) => {
		const hour = found[1] ? Number(found[1]) : 20;
		const minutes = Number(found[2] || 0);
		return withTime(now, hour <= 11 ? hour + 12 : hour, minutes);
	});

	// "at 5", "at 17:00", "at 5:30pm", or a bare "5pm"
	take(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b/i, (found) => {
		const suffix = found[3]?.toLowerCase();
		const hour = Number(found[1] ?? found[4]);
		const minutes = Number(found[2] ?? found[5] ?? 0);
		if (!Number.isFinite(hour) || hour > 23) return undefined;
		if (suffix) {
			let resolved = hour % 12;
			if (suffix === "pm") resolved += 12;
			const date = withTime(now, resolved, minutes);
			if (date <= now) date.setDate(date.getDate() + 1);
			return date;
		}
		const resolved = resolveBareHour(now, hour, minutes);
		assumedEvening = Boolean(resolved.assumedEvening);
		return resolved.date;
	});

	const message = text
		.replace(/\b(?:on|at|by)\s*$/i, "")
		.replace(/\s{2,}/g, " ")
		.trim();

	return {
		message: message || original,
		at,
		matched,
		assumedEvening: at ? assumedEvening : undefined,
	};
}

/** Human phrasing for the confirmation card. */
export function describeWhen(at: Date, now = new Date()): string {
	const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
	const sameDay = at.toDateString() === now.toDateString();
	const tomorrow = new Date(now);
	tomorrow.setDate(tomorrow.getDate() + 1);
	if (sameDay) return `today at ${time}`;
	if (at.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
	const days = Math.round((at.getTime() - now.getTime()) / 86_400_000);
	if (days < 7) return `${WEEKDAYS[at.getDay()]} at ${time}`;
	return `${at.toLocaleDateString()} at ${time}`;
}
