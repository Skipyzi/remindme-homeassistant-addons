/**
 * Routing evaluation against a live model.
 *
 *   LOCAL_LLM_URL=http://homeassistant.local:8080/v1/chat/completions \
 *     node --import tsx eval/run.ts [--only substring] [--verbose]
 *
 * Every case runs the real decision call (same prompt, same grammar) over a
 * fixture house, and is scored on action, targets and command. Use it to
 * compare catalog models before switching, and after touching the prompts.
 */
import { readFileSync } from "node:fs";
import { normalizeEntity, type HassEntity } from "../src/harness/entities.ts";
import {
	asksToRemember,
	looksLikeCommand,
	decisionSchema,
	validateDecision,
	type ActionContext,
} from "../src/agent/actions.ts";
import { candidatesForTurn } from "../src/agent/candidates.ts";
import { decide, type ModelEndpoint } from "../src/agent/llm.ts";
import { decideMessages } from "../src/agent/prompts.ts";

interface Case {
	prompt: string;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
	expect: { action: string; targets?: string[]; command?: string; value?: string };
}

const fixtures = JSON.parse(
	readFileSync(new URL("./fixtures.json", import.meta.url), "utf8"),
) as { house: HassEntity[]; cases: Case[] };
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";
const verbose = args.includes("--verbose");
const url = process.env.LOCAL_LLM_URL || "http://homeassistant:8080/v1/chat/completions";
const endpoint: ModelEndpoint = {
	url: new URL(url),
	model: process.env.LOCAL_LLM_MODEL || "local",
	headers: { "Content-Type": "application/json" },
	openaiCompat: process.env.OPENAI_COMPAT === "true",
	label: "eval",
};
const cards = fixtures.house.map(normalizeEntity);

let passed = 0;
let actionOk = 0;
let total = 0;
let totalMs = 0;
const failures: string[] = [];
for (const item of fixtures.cases) {
	if (only && !item.prompt.includes(only)) continue;
	total += 1;
	const candidates = candidatesForTurn(cards, item.prompt, item.history || []);
	const context: ActionContext = {
		home: true,
		homeControl: looksLikeCommand(item.prompt, item.history || []),
		candidates,
		reminders: true,
		web: true,
		memory: true,
		memoryWrite: asksToRemember(item.prompt),
		parcels: true,
		documents: true,
		mcpTools: [],
	};
	const started = Date.now();
	let decision: Record<string, unknown>;
	let raw = "";
	try {
		const result = await decide(
			endpoint,
			decideMessages(context, {
				prompt: item.prompt,
				candidates,
				history: item.history,
			}),
			decisionSchema(context),
			{ maxTokens: 160 },
		);
		raw = result.raw;
		decision = validateDecision(result.value, context) as Record<string, unknown>;
	} catch (error) {
		decision = { action: "error", error: String(error) };
	}
	const ms = Date.now() - started;
	totalMs += ms;
	const expect = item.expect;
	const problems: string[] = [];
	if (decision.action !== expect.action) problems.push(`action ${decision.action}`);
	else actionOk += 1;
	if (expect.targets) {
		const got = new Set((decision.targets as string[]) || []);
		const want = new Set(expect.targets);
		if (got.size !== want.size || [...want].some((target) => !got.has(target)))
			problems.push(`targets ${JSON.stringify([...got])}`);
	}
	if (expect.command && decision.command !== expect.command)
		problems.push(`command ${decision.command}`);
	if (expect.value && String(decision.value || "").replace(/[%°c ]/gi, "") !== expect.value)
		problems.push(`value ${decision.value}`);
	const ok = problems.length === 0;
	if (ok) passed += 1;
	else failures.push(`✗ ${item.prompt}\n    want ${JSON.stringify(expect)}\n    got  ${raw || JSON.stringify(decision)}`);
	const mark = ok ? "✓" : "✗";
	console.log(`${mark} ${String(ms).padStart(6)}ms  ${item.prompt}${verbose || !ok ? `  →  ${raw}` : ""}`);
	if (verbose) console.log(`         candidates: ${candidates.map((c) => c.label).join(", ")}`);
}
console.log("\n" + failures.join("\n"));
console.log(
	`\nexact ${passed}/${total} (${Math.round((passed / total) * 100)}%)  ·  action ${actionOk}/${total} (${Math.round((actionOk / total) * 100)}%)  ·  avg ${Math.round(totalMs / total)}ms`,
);
