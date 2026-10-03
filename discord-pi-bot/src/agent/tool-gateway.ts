import { randomUUID } from "node:crypto";
import { execute, type ExecutorDeps, type Confirmation } from "./execute";
import { HOME_COMMANDS, type Decision, type LightSetting } from "./actions";
import { planCommand, planLightSettings } from "./home";
import type { Candidate } from "./candidates";
import type { EntityCard } from "../harness/entities";
import type { ValidatedEntityAction } from "../harness/entityActions";
import type { SendEvent } from "../harness/sse";

export interface AgentTool { name: string; description: string; inputSchema: Record<string, unknown> }
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string", minLength: 1, maxLength: 2000 };
const targets = { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" } };
export function homeTools(deps: ExecutorDeps): AgentTool[] {
	const tools: AgentTool[] = [];
	if (deps.home) tools.push(
		{ name: "home_entities", description: "Find real Home Assistant entities by name, ID, area or domain. Read these before selecting targets. Returns current states and supported controls.", inputSchema: object({ query: { type: "string", maxLength: 200 }, domain: { type: "string", maxLength: 60 } }) },
		{ name: "home_status", description: "Read fresh device states for exact entity IDs. Use to diagnose reported failures.", inputSchema: object({ targets }, ["targets"]) },
		{ name: "home_control", description: "Control up to eight existing entities. Brightness, volume, fan and position use 0–100; color uses #RRGGBB; temperature uses degrees. Sensitive actions return a confirmation card and wait for the user to tap it. Never treat awaiting confirmation or an unverified result as success.", inputSchema: object({ targets, command: { type: "string", enum: [...HOME_COMMANDS] }, value: { type: "string", maxLength: 200 } }, ["targets", "command"]) },
		{ name: "home_lighting", description: "Apply a light scene to exact existing light IDs. Brightness is 0–100, color #RRGGBB, color_temperature is kelvin. Do call this for scene follow-ups; describing settings does not apply them.", inputSchema: object({ lights: { type: "array", minItems: 1, maxItems: 8, items: object({ target: text, brightness: { type: "number", minimum: 0, maximum: 100 }, color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }, color_temperature: { type: "number", minimum: 1000, maximum: 12000 } }, ["target"]) } }, ["lights"]) },
	);
	tools.push({ name: "reminder_list", description: "List the owner's reminders.", inputSchema: object({}) }, { name: "reminder_add", description: "Prepare a reminder from the user's request, including its time. Scheduling waits for the user's confirmation card.", inputSchema: object({ request: text }, ["request"]) });
	if (deps.webSearch) tools.push({ name: "web_search", description: "Search the web for current information.", inputSchema: object({ query: text }, ["query"]) });
	if (deps.vault) tools.push({ name: "memory_recall", description: "Search the user's saved notes.", inputSchema: object({ query: text }, ["query"]) }, { name: "memory_save", description: "Save a fact only when the user explicitly asks you to remember it.", inputSchema: object({ title: text, fact: text }, ["title", "fact"]) });
	if (deps.parcels) tools.push({ name: "parcel_list", description: "List tracked parcels.", inputSchema: object({}) }, { name: "parcel_track", description: "Track a parcel requested by the user.", inputSchema: object({ tracking_number: text, label: text }, ["tracking_number"]) });
	return tools;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object");
	return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== "string" || !value.trim() || value.length > 2000) throw new Error("A nonempty text argument is required"); return value; }
function ids(value: unknown): string[] {
	if (!Array.isArray(value) || !value.length || value.length > 8 || value.some(id => typeof id !== "string" || !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(id)) || new Set(value).size !== value.length) throw new Error("Select one to eight unique existing entity IDs");
	return value;
}

/** Report observations separately from service acceptance; physical state can lag. */
export function verifyAction(plan: ValidatedEntityAction, card?: EntityCard) {
	if (!card?.available) return { entityId: plan.entityId, status: "unavailable", expected: plan.serviceData, observed: card || null };
	const expected: Record<string, unknown> = { ...plan.serviceData };
	const states: Record<string, string> = { turn_on: "on", turn_off: "off", lock: "locked", unlock: "unlocked", open_cover: "open", close_cover: "closed", media_play: "playing", media_pause: "paused" };
	if (states[plan.service]) expected.state = states[plan.service];
	const observed: Record<string, unknown> = { state: card.state, hvac_mode: card.state, brightness: card.brightness, rgb_color: card.rgbColor, color_temp_kelvin: card.colorTemperature, temperature: card.targetTemperature, position: card.position, percentage: card.fanPercentage, ...card.attributes };
	const checks = Object.entries(expected).filter(([key]) => key !== "entity_id").map(([key, value]) => {
		const actual = observed[key];
		if (Array.isArray(value)) return Array.isArray(actual) && value.length === actual.length && value.every((n, i) => Math.abs(Number(n) - Number(actual[i])) <= 20);
		if (typeof value === "number") {
			const tolerance = key === "brightness" ? 3 : key === "color_temp_kelvin" ? 150 : key === "temperature" ? (card.temperatureStep || 0.5) / 2 : key === "volume_level" ? 0.02 : ["position", "percentage"].includes(key) ? 1 : 0.01;
			return typeof actual === "number" && Math.abs(value - actual) <= tolerance;
		}
		return value === actual;
	});
	return { entityId: plan.entityId, status: checks.length ? checks.every(Boolean) ? "verified" : "mismatch" : "unverified", expected, observed: card };
}

export function createToolGateway(deps: ExecutorDeps, send: SendEvent, signal: AbortSignal, receipt: (name: string, result: unknown) => void) {
	const allowed = new Set(homeTools(deps).map(tool => tool.name));
	return async (name: string, input: unknown): Promise<unknown> => {
		signal.throwIfAborted();
		if (!allowed.has(name)) throw new Error("This tool is not enabled");
		const args = record(input);
		const phaseId = `tool-${randomUUID()}`;
		send("tool_start", { phaseId, iteration: 0, kind: "tool", state: "active", name, arguments: args });
		try {
			const cards = name.startsWith("home_") ? await deps.home!.cards(0) : [];
			signal.throwIfAborted();
			if (name === "home_entities") {
				const query = String(args.query || "").toLowerCase().slice(0, 200);
				const found = cards.filter(card => (!args.domain || card.domain === args.domain) && `${card.entityId} ${card.name} ${card.area || ""}`.toLowerCase().includes(query));
				const result = { entities: found.slice(0, 80), total: found.length, truncated: found.length > 80 };
				receipt(name, result);
				send("tool_complete", { phaseId, iteration: 0, kind: "tool", state: "complete", name, result });
				return result;
			}
			let decision: Decision;
			let selected: string[] = [];
			if (name === "home_lighting") {
				if (!Array.isArray(args.lights)) throw new Error("lights is required");
				selected = ids(args.lights.map(light => record(light).target));
				const lights: LightSetting[] = args.lights.map(light => {
					const setting = record(light);
					for (const key of Object.keys(setting)) if (!["target", "brightness", "color", "color_temperature"].includes(key)) throw new Error("Unknown light setting");
					if (setting.brightness !== undefined && typeof setting.brightness !== "number" || setting.color_temperature !== undefined && typeof setting.color_temperature !== "number" || setting.color !== undefined && typeof setting.color !== "string") throw new Error("Invalid light setting type");
					return setting as unknown as LightSetting;
				});
				decision = { action: name, lights };
			} else if (name === "home_control") {
				selected = ids(args.targets);
				if (!HOME_COMMANDS.includes(args.command as any)) throw new Error("Unknown home command");
				decision = { action: name, targets: selected, command: args.command as any, value: args.value === undefined ? undefined : string(args.value) };
			} else if (name === "home_status") { selected = ids(args.targets); decision = { action: name, targets: selected }; }
			else if (name === "reminder_add") decision = { action: name, request: string(args.request) };
			else if (name === "web_search" || name === "memory_recall") decision = { action: name, query: string(args.query) };
			else if (name === "memory_save") decision = { action: name, title: string(args.title), fact: string(args.fact) };
			else if (name === "parcel_track") decision = { action: name, tracking_number: string(args.tracking_number), label: args.label === undefined ? undefined : string(args.label) };
			else decision = { action: name as "reminder_list" | "parcel_list" };
			const candidates: Candidate[] = selected.map(id => {
				const card = cards.find(card => card.entityId === id);
				if (!card) throw new Error(`Unknown entity: ${id}. Use home_entities to find the device.`);
				return { label: id, card, score: 1 };
			});
			// Preflight every target before any service calls, including capability/range checks.
			const plans = decision.action === "home_lighting" ? decision.lights.map(light => planLightSettings(candidates.find(c => c.label === light.target)!.card, light)) : decision.action === "home_control" ? candidates.map(c => planCommand(c.card, decision.command, decision.value)) : [];
			const guarded = { ...deps, home: deps.home ? new Proxy(deps.home, { get(target, key) { const value = Reflect.get(target, key); if (key === "service") return async (plan: ValidatedEntityAction) => { signal.throwIfAborted(); return target.service(plan); }; return typeof value === "function" ? value.bind(target) : value; } }) : undefined };
			const outcome = await execute(decision, candidates, guarded);
			const confirmations = [...(outcome.confirms || [])];
			let safeReceipt = outcome.result;
			if ((outcome.result as Partial<Confirmation>)?.confirmation_required) {
				const confirm = outcome.result as Confirmation;
				confirmations.push({ label: confirm.message, confirm });
				const { token: _token, ...withoutToken } = confirm;
				safeReceipt = withoutToken;
			}
			const done = new Set((outcome.result as any)?.done || (outcome.result as any)?.applied || []);
			const verification = [];
			for (const plan of plans.filter(plan => done.has(plan.entityId))) {
				let observed = outcome.cards?.find(card => card.entityId === plan.entityId);
				let checked = verifyAction(plan, observed);
				for (let attempt = 0; attempt < 3 && checked.status !== "verified" && !signal.aborted; attempt++) {
					await new Promise(resolve => setTimeout(resolve, 350));
					if (signal.aborted) break;
					observed = await deps.home!.card(plan.entityId);
					checked = verifyAction(plan, observed);
				}
				if (observed && outcome.cards) outcome.cards = outcome.cards.map(card => card.entityId === observed!.entityId ? observed! : card);
				verification.push({ ...checked, serviceAccepted: true });
			}
			const result = { receipt: safeReceipt, verification, confirmations: confirmations.map(c => ({ entity: c.label, pending: true })), cards: outcome.cards, facts: outcome.facts, answer: verification.some(check => check.status !== "verified") ? "Home Assistant accepted the call, but the requested device state was not verified. Report the observations and uncertainty." : outcome.answer };
			receipt(name, result);
			send("tool_complete", { phaseId, iteration: 0, kind: "tool", state: "complete", name, result, view: outcome.view });
			for (const { label, confirm } of confirmations) {
				const confirmationName = `${name} · ${label}`;
				send("tool_start", { phaseId, iteration: 0, kind: "tool", state: "active", name: confirmationName, arguments: {} });
				send("tool_complete", { phaseId, iteration: 0, kind: "tool", state: "complete", name: confirmationName, result: confirm });
			}
			return result;
		} catch (error) {
			const result = { error: error instanceof Error ? error.message : "Tool failed" };
			receipt(name, result);
			send("tool_complete", { phaseId, iteration: 0, kind: "tool", state: "error", name, result });
			return result;
		}
	};
}
