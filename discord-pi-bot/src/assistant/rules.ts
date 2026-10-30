import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * What the assistant may do on its own, per kind of action: just do it, ask
 * first (it waits for the user's tap, like a lock does), or never. Anything
 * that opens the house or speaks for the user (sending mail, buying on a
 * website) can be asked for or turned off, never done unasked.
 */

export type RuleChoice = "auto" | "ask" | "never";
export type RuleId = "devices" | "covers" | "other" | "security" | "calendar" | "todo" | "mail" | "web" | "jobs";

export interface Rule {
	id: RuleId;
	label: string;
	detail: string;
	choices: RuleChoice[];
	default: RuleChoice;
}

export const RULES: Rule[] = [
	{ id: "devices", label: "Lights, switches, heating and media", detail: "On and off, dimming, colour, temperature, volume.", choices: ["auto", "ask", "never"], default: "auto" },
	{ id: "covers", label: "Blinds, shades and valves", detail: "Covers that aren't doors or gates, and water valves.", choices: ["auto", "ask", "never"], default: "ask" },
	{ id: "other", label: "Scenes, scripts, vacuums and the rest", detail: "Anything in Home Assistant that isn't listed above.", choices: ["auto", "ask", "never"], default: "ask" },
	{ id: "security", label: "Locks, doors, gates and the alarm", detail: "These open the house, so they always wait for your tap when allowed.", choices: ["ask", "never"], default: "ask" },
	{ id: "calendar", label: "Calendar events", detail: "New events in the calendar chosen under Connectors.", choices: ["auto", "ask", "never"], default: "ask" },
	{ id: "todo", label: "To-do lists", detail: "Adding items and ticking them off.", choices: ["auto", "ask", "never"], default: "auto" },
	{ id: "mail", label: "Sending email", detail: "Drafts are always fine. Sending speaks for you, so it waits for your tap when allowed.", choices: ["ask", "never"], default: "ask" },
	{ id: "web", label: "Buying, booking and signing up on websites", detail: "Its browser holds these clicks for your tap when allowed.", choices: ["ask", "never"], default: "ask" },
	{ id: "jobs", label: "Background jobs", detail: "Work that goes on after the answer, such as comparing shops or watching a parcel. They use the AI budget.", choices: ["auto", "ask", "never"], default: "auto" },
];

const WORDS: Record<RuleChoice, string> = { auto: "does it", ask: "asks first", never: "never" };

export class RuleStore {
	private chosen: Partial<Record<RuleId, RuleChoice>> = {};
	private saving = Promise.resolve();

	constructor(private readonly path = process.env.RULES_DATA_PATH || "./data/rules.json") {}

	async load(): Promise<void> {
		try {
			const saved = JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
			this.chosen = {};
			for (const rule of RULES) {
				const value = saved?.[rule.id];
				if (typeof value === "string" && rule.choices.includes(value as RuleChoice)) this.chosen[rule.id] = value as RuleChoice;
			}
		} catch {
			this.chosen = {};
		}
	}

	get(id: RuleId): RuleChoice {
		const rule = RULES.find((entry) => entry.id === id)!;
		return this.chosen[id] ?? rule.default;
	}

	/** Every rule with what it's set to, for Settings. */
	view(): Array<Rule & { choice: RuleChoice }> {
		return RULES.map((rule) => ({ ...rule, choice: this.get(rule.id) }));
	}

	set(id: string, choice: string): void {
		const rule = RULES.find((entry) => entry.id === id);
		if (!rule) throw new Error("There's no such rule.");
		if (!rule.choices.includes(choice as RuleChoice)) throw new Error(`${rule.label} can't be set to that.`);
		if (choice === rule.default) delete this.chosen[rule.id];
		else this.chosen[rule.id] = choice as RuleChoice;
		const snapshot = JSON.stringify(this.chosen);
		this.saving = this.saving
			.then(async () => {
				await mkdir(dirname(this.path), { recursive: true });
				await writeFile(`${this.path}.tmp`, snapshot);
				await rename(`${this.path}.tmp`, this.path);
			})
			.catch((error) => console.warn("Could not save the rules:", error instanceof Error ? error.message : error));
	}

	flushed(): Promise<void> {
		return this.saving;
	}

	/** For each turn's context: what the user changed from the defaults, so the model doesn't try. */
	context(): string | undefined {
		const changed = RULES.filter((rule) => this.chosen[rule.id] !== undefined);
		if (!changed.length) return undefined;
		return `The user's rules for what you may do (Settings → What it may do): ${changed.map((rule) => `${rule.label.toLowerCase()}: ${WORDS[this.get(rule.id)]}`).join("; ")}. Something set to never is off: say so, and don't try another way.`;
	}
}

/** Which rule a device command falls under. */
export function deviceRule(domain: string, deviceClass?: string): RuleId {
	if (domain === "lock" || domain === "alarm_control_panel") return "security";
	if (domain === "cover") return ["garage", "door", "gate"].includes(deviceClass || "") ? "security" : "covers";
	if (domain === "valve") return "covers";
	if (["light", "switch", "fan", "media_player", "climate"].includes(domain)) return "devices";
	return "other";
}

/** What a tool says when the user has turned a kind of action off. */
export const turnedOff = (rule: RuleId) => `The user has turned off "${RULES.find((entry) => entry.id === rule)!.label}" under Settings → What it may do. Tell them so in a sentence; don't try another way.`;
