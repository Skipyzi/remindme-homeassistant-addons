import { normalizeEntity, type EntityCard, type HassEntity } from "../harness/entities";
import {
	confirmationPolicy,
	validateEntityAction,
	type EntityAction,
	type ValidatedEntityAction,
} from "../harness/entityActions";
import type { HomeCommand } from "./actions";

/**
 * Home Assistant, as the agent sees it: states with their areas attached,
 * service calls, and the built-in conversation agent. Everything goes through
 * the Supervisor proxy with the add-on's token.
 */
export class HomeApi {
	private statesCache?: { at: number; cards: EntityCard[] };
	private areasCache?: { at: number; areas: Map<string, string> };

	constructor(
		private readonly token: string,
		private readonly baseUrl = "http://supervisor/core/api",
		private readonly fetcher: typeof fetch = fetch,
	) {}

	private async call(path: string, init: RequestInit = {}): Promise<Response> {
		const response = await this.fetcher(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			signal: init.signal ?? AbortSignal.timeout(10_000),
		});
		if (!response.ok) throw new Error(`Home Assistant returned HTTP ${response.status}`);
		return response;
	}

	/**
	 * entity_id → area name. /api/states carries no areas, and without them
	 * "the kitchen lights" only works when every bulb has "kitchen" in its
	 * name. One template render fetches the lot; it changes rarely, so it is
	 * cached for minutes, not seconds.
	 */
	async areas(): Promise<Map<string, string>> {
		if (this.areasCache && Date.now() - this.areasCache.at < 300_000)
			return this.areasCache.areas;
		const areas = new Map<string, string>();
		try {
			const response = await this.call("/template", {
				method: "POST",
				body: JSON.stringify({
					template:
						"{% for s in states %}{% set a = area_name(s.entity_id) %}{% if a %}{{ s.entity_id }}\t{{ a }}\n{% endif %}{% endfor %}",
				}),
			});
			for (const line of (await response.text()).split("\n")) {
				const [entityId, area] = line.split("\t");
				if (entityId && area) areas.set(entityId.trim(), area.trim());
			}
		} catch (error) {
			console.warn("Area lookup failed:", error instanceof Error ? error.message : error);
		}
		this.areasCache = { at: Date.now(), areas };
		return areas;
	}

	/** Every entity as a card, with its area. Cached briefly: one turn reads it twice. */
	async cards(maxAgeMs = 3_000): Promise<EntityCard[]> {
		if (this.statesCache && Date.now() - this.statesCache.at < maxAgeMs)
			return this.statesCache.cards;
		const [states, areas] = await Promise.all([
			this.call("/states").then((response) => response.json() as Promise<HassEntity[]>),
			this.areas(),
		]);
		const cards = states.map((state) => withArea(state, areas));
		this.statesCache = { at: Date.now(), cards };
		return cards;
	}

	async card(entityId: string): Promise<EntityCard | undefined> {
		try {
			const response = await this.call(`/states/${encodeURIComponent(entityId)}`);
			return withArea((await response.json()) as HassEntity, await this.areas());
		} catch {
			return undefined;
		}
	}

	async service(action: ValidatedEntityAction): Promise<void> {
		this.statesCache = undefined;
		await this.call(`/services/${action.domain}/${action.service}`, {
			method: "POST",
			body: JSON.stringify({ ...action.serviceData, entity_id: action.entityId }),
		});
	}

	/**
	 * Ask Home Assistant's own intent engine. It matches fixed sentence
	 * templates, so it is instant, needs no model, and either handles a
	 * command exactly or says it did not understand — it does not guess.
	 */
	async converse(text: string, signal?: AbortSignal): Promise<IntentReply> {
		const response = await this.call("/conversation/process", {
			method: "POST",
			body: JSON.stringify({
				text,
				language: "en",
				// The built-in agent specifically: if the default agent is an
				// LLM, sending there would be a model call by another route.
				agent_id: "conversation.home_assistant",
			}),
			// Both: a cancelled turn stops waiting, and a slow Home Assistant
			// hands over to the model instead of stalling the turn.
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(4_000)])
				: AbortSignal.timeout(4_000),
		});
		this.statesCache = undefined;
		return (await response.json()) as IntentReply;
	}
}

function withArea(state: HassEntity, areas: Map<string, string>): EntityCard {
	const area = areas.get(state.entity_id);
	return normalizeEntity(
		area && !state.attributes?.area_name
			? { ...state, attributes: { ...state.attributes, area_name: area } }
			: state,
	);
}

export interface IntentReply {
	response?: {
		response_type?: "action_done" | "query_answer" | "error";
		speech?: { plain?: { speech?: string } };
		data?: {
			code?: string;
			success?: Array<{ id: string; name: string; type: string }>;
			failed?: Array<{ id: string; name: string; type: string }>;
		};
	};
}

/**
 * Words that keep a request away from the fast path. Home Assistant would
 * carry these out on the spot; here they must go through a confirm card.
 */
const riskyTerms =
	/\b(unlock|lock|locks|door|doors|garage|gate|alarm|disarm|arm|open|opening|close|blinds?|shutters?|curtains?|covers?|valves?|shades?|awnings?|windows?|scripts?|scenes?|vacuum)\b/i;

export function fastPathEligible(prompt: string): boolean {
	const text = prompt.trim();
	if (!text || text.length > 160 || text.split(/\s+/).length > 16) return false;
	if (riskyTerms.test(text)) return false;
	return true;
}

export interface IntentOutcome {
	speech: string;
	entityIds: string[];
	kind: "action_done" | "query_answer";
}

/** The reply as an outcome, or undefined when Home Assistant did not handle it. */
export function readIntentReply(reply: IntentReply): IntentOutcome | undefined {
	const response = reply.response;
	const kind = response?.response_type;
	if (kind !== "action_done" && kind !== "query_answer") return undefined;
	const speech = response?.speech?.plain?.speech?.trim() || "Done.";
	const entityIds = (response?.data?.success || [])
		.filter((target) => target.type === "entity" && /^[a-z0-9_]+\.[a-z0-9_]+$/.test(target.id))
		.map((target) => target.id);
	return { speech, entityIds: [...new Set(entityIds)].slice(0, 12), kind };
}

/* ── Commands → service calls ───────────────────────────────────────── */

const colorNames: Record<string, [number, number, number]> = {
	red: [255, 0, 0],
	green: [0, 200, 0],
	blue: [0, 80, 255],
	yellow: [255, 220, 0],
	orange: [255, 140, 0],
	purple: [150, 60, 255],
	violet: [150, 60, 255],
	pink: [255, 105, 180],
	magenta: [255, 0, 255],
	cyan: [0, 255, 255],
	turquoise: [64, 224, 208],
	white: [255, 255, 255],
	warm: [255, 180, 107],
};

const colorTemperatures: Record<string, number> = {
	candle: 2000,
	warmest: 2200,
	warm: 2700,
	soft: 3000,
	neutral: 4000,
	cool: 5000,
	cold: 6000,
	daylight: 6500,
};

/** "30", "30%", "+10", "-10", "half", "max" → a number, flagged relative or not. */
export function parseAmount(value = ""): { amount: number; relative: boolean } | undefined {
	const text = value.trim().toLowerCase();
	if (!text) return undefined;
	const words: Record<string, number> = { half: 50, full: 100, max: 100, maximum: 100, min: 1, minimum: 1 };
	if (text in words) return { amount: words[text], relative: false };
	const match = text.match(/^([+-])?\s*(\d+(?:[.,]\d+)?)/);
	if (!match) return undefined;
	const amount = Number(match[2].replace(",", "."));
	if (!Number.isFinite(amount)) return undefined;
	return match[1]
		? { amount: match[1] === "-" ? -amount : amount, relative: true }
		: { amount, relative: false };
}

const clamp = (value: number, low: number, high: number) =>
	Math.min(high, Math.max(low, value));

function custom(
	card: EntityCard,
	service: string,
	serviceData: Record<string, unknown> = {},
): ValidatedEntityAction {
	if (!card.available) throw new Error(`${card.name} is unavailable`);
	return {
		domain: card.domain,
		service,
		entityId: card.entityId,
		serviceData,
		...confirmationPolicy(card.domain, service),
	};
}

/**
 * Turn the model's command into a checked Home Assistant service call. The
 * model only said "set_brightness 30"; which service, which attribute, which
 * units, and whether the device can do it at all is decided here.
 */
export function planCommand(
	card: EntityCard,
	command: HomeCommand,
	value?: string,
): ValidatedEntityAction {
	const domain = card.domain;
	const validate = (action: EntityAction, arg?: unknown) =>
		validateEntityAction(card, action, arg);
	const amount = parseAmount(value);
	switch (command) {
		case "turn_on":
		case "turn_off": {
			if (domain === "cover") return validate(command === "turn_on" ? "open_cover" : "close_cover");
			if (domain === "lock") throw new Error(`Say lock or unlock for ${card.name}`);
			if (["climate", "humidifier", "scene", "script"].includes(domain)) {
				if (command === "turn_off" && domain !== "climate" && domain !== "humidifier")
					throw new Error(`${card.name} cannot be turned off`);
				return custom(card, command);
			}
			if (domain === "light" && command === "turn_on" && amount && !amount.relative)
				return validate("brightness", Math.round(clamp(amount.amount, 0, 100) * 2.55));
			return validate(command);
		}
		case "toggle":
			return validate("toggle");
		case "set_brightness": {
			if (!amount) throw new Error(`Say what brightness for ${card.name}`);
			const current = card.state === "on" ? Math.round(((card.brightness ?? 255) / 255) * 100) : 0;
			const percent = clamp(amount.relative ? current + amount.amount : amount.amount, 0, 100);
			if (percent === 0) return validate("turn_off");
			return validate("brightness", Math.max(1, Math.round(percent * 2.55)));
		}
		case "set_color": {
			const name = String(value || "").trim().toLowerCase();
			const hex = name.match(/^#?([0-9a-f]{6})$/);
			const rgb = hex
				? [0, 2, 4].map((offset) => parseInt(hex[1].slice(offset, offset + 2), 16))
				: colorNames[name];
			if (!rgb) throw new Error(`Unknown colour "${value}"`);
			return validate("rgb_color", rgb);
		}
		case "set_color_temperature": {
			const name = String(value || "warm").trim().toLowerCase();
			const current = card.colorTemperature ?? 4000;
			let kelvin = colorTemperatures[name];
			if (kelvin === undefined) {
				if (/warmer/.test(name)) kelvin = current - 700;
				else if (/cooler|colder/.test(name)) kelvin = current + 700;
				else if (amount) kelvin = amount.relative ? current + amount.amount : amount.amount;
			}
			if (kelvin === undefined) throw new Error(`Unknown colour temperature "${value}"`);
			return validate("color_temperature", clamp(Math.round(kelvin), 2000, 6500));
		}
		case "set_temperature": {
			if (!amount) throw new Error(`Say which temperature for ${card.name}`);
			const current = card.targetTemperature ?? card.currentTemperature ?? 20;
			return validate("set_temperature", amount.relative ? current + amount.amount : amount.amount);
		}
		case "set_hvac_mode":
			return validate("set_hvac_mode", String(value || "").trim().toLowerCase());
		case "set_position":
			// "set_position closed" is a close, whatever slot the word landed in.
			if (!amount && /^(closed?|shut|down)$/i.test(String(value).trim()))
				return planCommand(card, "close");
			if (!amount && /^(open(ed)?|up)$/i.test(String(value).trim()))
				return planCommand(card, "open");
			if (!amount) throw new Error(`Say which position for ${card.name}`);
			return validate("set_position", clamp(amount.relative ? (card.position ?? 0) + amount.amount : amount.amount, 0, 100));
		case "open":
		case "close":
			if (domain === "cover") return validate(command === "open" ? "open_cover" : "close_cover");
			if (domain === "valve") return custom(card, command === "open" ? "open_valve" : "close_valve");
			throw new Error(`${card.name} cannot be ${command === "open" ? "opened" : "closed"}`);
		case "lock":
		case "unlock":
			return validate(command);
		case "set_fan_speed": {
			if (!amount) throw new Error(`Say what speed for ${card.name}`);
			const current = card.fanPercentage ?? 0;
			return validate("set_fan_speed", clamp(amount.relative ? current + amount.amount : amount.amount, 0, 100));
		}
		case "play":
		case "pause":
		case "next_track":
			if (domain !== "media_player") throw new Error(`${card.name} is not a media player`);
			return custom(card, { play: "media_play", pause: "media_pause", next_track: "media_next_track" }[command]);
		case "set_volume": {
			if (domain !== "media_player") throw new Error(`${card.name} is not a media player`);
			if (!amount) throw new Error(`Say what volume for ${card.name}`);
			const current = Math.round(Number(card.attributes?.volume_level ?? 0.3) * 100);
			const percent = clamp(amount.relative ? current + amount.amount : amount.amount, 0, 100);
			return custom(card, "volume_set", { volume_level: percent / 100 });
		}
		case "start":
		case "return_home":
			if (domain !== "vacuum") throw new Error(`${card.name} is not a vacuum`);
			return custom(card, command === "start" ? "start" : "return_to_base");
	}
	throw new Error(`Unsupported command ${command}`);
}

/** How a command reads in a confirmation or a reply: "turn off", "set to 30%". */
export function describeCommand(command: HomeCommand, value?: string): string {
	const phrases: Partial<Record<HomeCommand, string>> = {
		turn_on: "turn on",
		turn_off: "turn off",
		toggle: "toggle",
		open: "open",
		close: "close",
		lock: "lock",
		unlock: "unlock",
		play: "play",
		pause: "pause",
		next_track: "skip to the next track on",
		start: "start",
		return_home: "send home",
	};
	if (phrases[command]) return phrases[command]!;
	const unit: Partial<Record<HomeCommand, string>> = {
		set_brightness: "%",
		set_position: "%",
		set_fan_speed: "%",
		set_volume: "%",
		set_temperature: "°",
	};
	const clean = String(value || "").replace(/[%°]/g, "");
	return `set ${clean}${unit[command] || ""}`.trim();
}

const openingClasses = new Set(["door", "window", "opening", "garage_door"]);
const detectedClasses = new Set(["motion", "occupancy", "presence", "smoke", "gas", "carbon_monoxide"]);

/** A card's state in words: "on at 70%", "20.5 °C", "open", "heating to 21°". */
export function stateText(card: EntityCard): string {
	if (!card.available) return "unavailable";
	switch (card.domain) {
		case "light":
			return card.state === "on" && card.brightness !== undefined
				? `on at ${Math.round((card.brightness / 255) * 100)}%`
				: card.state;
		case "binary_sensor": {
			const on = card.state === "on";
			if (card.deviceClass && openingClasses.has(card.deviceClass)) return on ? "open" : "closed";
			if (card.deviceClass && detectedClasses.has(card.deviceClass)) return on ? "detected" : "clear";
			if (card.deviceClass === "moisture") return on ? "wet" : "dry";
			return card.state;
		}
		case "climate": {
			const parts = [card.hvacAction || card.state];
			if (card.currentTemperature !== undefined) parts.push(`${card.currentTemperature}° now`);
			if (card.targetTemperature !== undefined) parts.push(`set to ${card.targetTemperature}°`);
			return parts.join(", ");
		}
		case "cover":
			return card.position !== undefined && card.state === "open"
				? `open ${card.position}%`
				: card.state;
		case "weather": {
			const temperature = card.attributes?.temperature;
			const unit = card.attributes?.temperature_unit || "°";
			const condition = card.state.replace(/-/g, " ");
			return temperature !== undefined ? `${condition}, ${temperature}${unit === "°C" || unit === "°F" ? unit : "°"}` : condition;
		}
		case "switch":
			return card.power !== undefined && card.state === "on"
				? `on, drawing ${card.power} W`
				: card.state;
		default:
			return card.unit ? `${card.state} ${card.unit}` : card.state;
	}
}

/** "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
	if (names.length <= 1) return names[0] || "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
