import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyUsage } from "../src/ai/types.ts";
import type { AskInput, AskResult } from "../src/assistant/agent.ts";
import { ConfirmationStore } from "../src/assistant/confirmations.ts";
import { JobRunner, jobBrief } from "../src/assistant/jobs.ts";
import { ThreadStore, titleFrom, type Thread } from "../src/assistant/threads.ts";
import { buildTools, newEffects, runTool, type ToolContext } from "../src/assistant/tools.ts";

const store = () => new ThreadStore(join(mkdtempSync(join(tmpdir(), "threads-")), "threads.json"));
const answer = (text = "", extra: Partial<AskResult> = {}): AskResult => ({ text, confirms: [], cards: [], artifacts: [], did: [], model: "test", usage: emptyUsage(), rounds: 1, ...extra });

/* A stand-in assistant: each run plays the next script against the job's tools. */
function scripted(threads: ThreadStore, scripts: Array<(input: AskInput) => AskResult | Promise<AskResult>>) {
	const inputs: AskInput[] = [];
	const notes: Array<{ title: string; text: string }> = [];
	const runner = new JobRunner({
		threads,
		ask: async (input) => {
			inputs.push(input);
			const next = scripts.shift();
			if (!next) throw new Error("no more scripted runs");
			return next(input);
		},
		notify: async (thread: Thread, text: string) => {
			notes.push({ title: thread.title, text });
		},
		runsPerGo: 3,
	});
	return { runner, inputs, notes };
}

test("a thread keeps its title short, and its history alternates for the model", async () => {
	assert.equal(titleFrom("  put the dentist\non friday  "), "put the dentist on friday");
	assert.equal(titleFrom("Find me a cheap flight to Budapest for the long weekend in March, from Leipzig or Berlin"), "Find me a cheap flight to Budapest for the long weekend…");
	const threads = store();
	const thread = threads.create({ title: "Flights", origin: "console" });
	threads.append(thread.id, { role: "user", text: "Find flights" });
	threads.append(thread.id, { role: "assistant", text: "On it." });
	threads.append(thread.id, { role: "step", text: "Eurowings: 84 €" });
	threads.append(thread.id, { role: "assistant", text: "Two options." });
	threads.append(thread.id, { role: "user", text: "Thursday" });
	assert.deepEqual(threads.history(thread.id), [
		{ role: "user", text: "Find flights" },
		{ role: "assistant", text: "On it.\n\nTwo options." },
		{ role: "user", text: "Thursday" },
	]);
	assert.equal(threads.list()[0].last, "Two options.", "the inbox line is the last thing RemindMe said");
	await threads.flushed();
	const again = new ThreadStore((threads as unknown as { path: string }).path);
	await again.load();
	assert.equal(again.get(thread.id)?.messages.length, 5);
});

test("a job started from a console thread waits for that turn, asks, then finishes on the answer", async () => {
	const threads = store();
	const thread = threads.create({ title: "Find me a cheap flight", origin: "console" });
	threads.append(thread.id, { role: "user", text: "Find me a cheap flight to Budapest in March" });
	threads.setBusy(thread.id, true);
	const { runner, inputs, notes } = scripted(threads, [
		(input) => {
			input.tools!.job!.update("Eurowings from Leipzig: 84 €, one stop", { done: 2, total: 6 }, "best so far 84 €");
			input.tools!.job!.update("Wizz Air from Berlin: 61 €", { done: 4, total: 6 }, "best so far 61 €");
			input.tools!.job!.ask("Thursday from Leipzig or Friday from Berlin?", ["Thursday", "Friday"]);
			return answer("Asked.");
		},
		(input) => {
			assert.equal(input.prompt, "Friday", "the answer is the next run's prompt");
			input.tools!.job!.finish("**Wizz Air, Fri 06:10 from BER, 61 €.** I'll watch the price.");
			return answer("Done.");
		},
	]);
	const started = runner.start({ title: "Flights to Budapest, 12–15 Mar", instructions: "Cheapest flights LEJ or BER to BUD, Thu 12 – Sun 15 March.", threadId: thread.id, origin: "console" });
	assert.equal(started.id, thread.id, "the conversation becomes the job");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(inputs.length, 0, "nothing runs while the turn that started it is still going");
	threads.append(thread.id, { role: "assistant", text: "I've started a job for that." });
	threads.setBusy(thread.id, false);
	await runner.settled();
	assert.equal(inputs[0].channel, "job");
	assert.equal(inputs[0].prompt, 'Start the job "Flights to Budapest, 12–15 Mar".');
	assert.match(inputs[0].extra || "", /What to do: Cheapest flights LEJ or BER/);
	assert.equal(inputs[0].conversationId, `thread:${thread.id}`);
	let job = threads.get(thread.id)!.job!;
	assert.equal(job.status, "needs_you");
	assert.deepEqual(job.progress, { done: 4, total: 6 });
	assert.equal(job.note, "best so far 61 €");
	assert.deepEqual(job.question, { text: "Thursday from Leipzig or Friday from Berlin?", options: ["Thursday", "Friday"] });
	assert.deepEqual(notes, [{ title: "Flights to Budapest, 12–15 Mar", text: "Thursday from Leipzig or Friday from Berlin?\n• Thursday\n• Friday" }]);
	assert.equal(threads.get(thread.id)!.messages.at(-1)!.text, "Thursday from Leipzig or Friday from Berlin?", "the thread shows the options as buttons, so its text doesn't list them");
	assert.match(jobBrief(threads.get(thread.id)!), /Steps so far[\s\S]*Eurowings from Leipzig: 84 €[\s\S]*Wizz Air from Berlin: 61 €/);
	assert.deepEqual(runner.waiting(), [{ id: thread.id, title: "Flights to Budapest, 12–15 Mar", question: "Thursday from Leipzig or Friday from Berlin?" }]);

	assert.equal(runner.answer(thread.id, "Friday"), true);
	await runner.settled();
	job = threads.get(thread.id)!.job!;
	assert.equal(job.status, "done");
	assert.equal(job.question, undefined);
	assert.deepEqual(job.progress, { done: 6, total: 6 }, "a finished job shows as complete");
	assert.equal(notes[1].text, "**Wizz Air, Fri 06:10 from BER, 61 €.** I'll watch the price.");
	assert.deepEqual(
		threads.get(thread.id)!.messages.map((message) => message.role),
		["user", "assistant", "step", "step", "assistant", "user", "assistant"],
	);
	assert.deepEqual(runner.waiting(), []);
});

test("a job that doesn't finish stops to check in instead of running on", async () => {
	const threads = store();
	const { runner, inputs, notes } = scripted(threads, [() => answer("Working."), () => answer("Still working."), () => answer("More.")]);
	const thread = runner.start({ title: "Sort receipts", instructions: "Sort this week's receipts", origin: "discord", request: "sort my receipts from this week" });
	await runner.settled();
	assert.equal(inputs.length, 3, "three runs, the cap in this test");
	assert.equal(inputs[0].prompt, 'sort my receipts from this week\n\nStart the job "Sort receipts".', "a job from Discord starts from the request itself");
	assert.equal(inputs[1].prompt, "sort my receipts from this week\n\nCarry on with the job from where you left off.", "the request stays in view, but isn't taken as a new answer");
	const job = threads.get(thread.id)!.job!;
	assert.equal(job.status, "stopped");
	assert.equal(job.runs, 3);
	assert.match(notes[0].text, /carry on/);
});

test("a failing AI stops the job and says why; stop and resume behave", async () => {
	const threads = store();
	const { runner, notes } = scripted(threads, [() => answer("Today's AI budget is used up.", { problem: "Today's AI budget is used up." })]);
	const failed = runner.start({ title: "Price watch", instructions: "Watch the price", origin: "console" });
	await runner.settled();
	assert.equal(threads.get(failed.id)!.job!.status, "stopped");
	assert.equal(threads.get(failed.id)!.job!.error, "Today's AI budget is used up.");
	assert.equal(notes[0].text, "I had to stop: Today's AI budget is used up.");

	let release!: () => void;
	const slow = scripted(threads, [
		(input) =>
			new Promise<AskResult>((resolve) => {
				release = () => resolve(answer("late"));
				input.signal?.addEventListener("abort", () => resolve(answer("aborted")));
			}),
	]);
	const running = slow.runner.start({ title: "Long one", instructions: "Take a while", origin: "console" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(threads.get(running.id)!.job!.status, "working");
	assert.equal(slow.runner.stop(running.id), true);
	await slow.runner.settled();
	assert.equal(threads.get(running.id)!.job!.status, "stopped");
	assert.equal(threads.get(running.id)!.job!.note, "Stopped by you");
	assert.equal(slow.notes.length, 0, "stopping it yourself sends nothing");
	assert.equal(slow.runner.stop(running.id), false);
	release?.();

	// After a restart, a queued job carries on.
	const queued = threads.create({ title: "Queued", origin: "console", job: { status: "queued", instructions: "x", runs: 0 } });
	const resumed = scripted(threads, [(input) => (input.tools!.job!.finish("ok"), answer())]);
	resumed.runner.resume();
	await resumed.runner.settled();
	assert.equal(threads.get(queued.id)!.job!.status, "done");
});

test("a job's held actions and changes land in its thread", async () => {
	const threads = store();
	const { runner } = scripted(threads, [
		(input) => {
			input.tools!.job!.finish("Booked the dentist in, waiting for your tap.");
			return answer("", { did: [{ text: "Living room: on at 40%" }], confirms: [{ confirmation_required: true, token: "t1", message: 'Add "Dentist" to Home', entityId: "calendar.home" }] });
		},
	]);
	const thread = runner.start({ title: "Dentist", instructions: "Find a slot", origin: "console" });
	await runner.settled();
	const steps = threads.get(thread.id)!.messages.filter((message) => message.role === "step");
	assert.deepEqual(steps.map((step) => step.text), ["Living room: on at 40%", "Waiting for your tap"]);
	assert.deepEqual(steps[1].confirms, [{ token: "t1", message: 'Add "Dentist" to Home', destructive: undefined }]);
});

test("start_job hands work off with the turn's thread; job tools exist only inside a job", async () => {
	const started: Array<Record<string, unknown>> = [];
	const base: ToolContext = { confirmations: new ConfirmationStore(), reminders: { add: async () => ({ id: "r" }), list: async () => [], cancel: async () => false } };
	const jobs = {
		start: (input: Record<string, unknown>) => (started.push(input), { id: "j1", title: String(input.title) }),
		answer: (id: string, text: string) => id === "j1" && Boolean(text),
	};
	const tools = await buildTools({ ...base, jobs: jobs as ToolContext["jobs"], turn: { channel: "console", prompt: "find flights", threadId: "t9" } }, { nativeWebSearch: true });
	const names = tools.map((tool) => tool.spec.name);
	assert.ok(names.includes("start_job") && names.includes("reply_to_job"));
	assert.ok(!names.includes("job_update"));
	const effects = newEffects();
	const result = await runTool(tools, { id: "1", name: "start_job", input: { title: "Flights to Budapest", instructions: "Cheapest, March" } }, effects);
	assert.equal(JSON.parse(result.content).started, true);
	assert.deepEqual(started[0], { title: "Flights to Budapest", instructions: "Cheapest, March", threadId: "t9", origin: "console", request: undefined });
	assert.deepEqual(effects.did, [{ text: "Started a job: Flights to Budapest" }]);
	assert.equal((await runTool(tools, { id: "2", name: "reply_to_job", input: { id: "nope", answer: "Friday" } }, newEffects())).isError, true);

	const fromDiscord = await buildTools({ ...base, jobs: jobs as ToolContext["jobs"], turn: { channel: "discord", prompt: "sort my receipts" } }, { nativeWebSearch: true });
	await runTool(fromDiscord, { id: "3", name: "start_job", input: { title: "Receipts", instructions: "Sort" } }, newEffects());
	assert.deepEqual([started[1].origin, started[1].request, started[1].threadId], ["discord", "sort my receipts", undefined]);

	const calls: string[] = [];
	const inside = await buildTools(
		{ ...base, jobs: jobs as ToolContext["jobs"], job: { update: (step, progress) => calls.push(`update ${step} ${JSON.stringify(progress)}`), ask: (question, options) => calls.push(`ask ${question} ${options.join("/")}`), finish: (text) => calls.push(`finish ${text}`) } },
		{ nativeWebSearch: true },
	);
	const insideNames = inside.map((tool) => tool.spec.name);
	assert.ok(insideNames.includes("job_update") && insideNames.includes("ask_user") && insideNames.includes("finish_job"));
	assert.ok(!insideNames.includes("start_job"), "a job doesn't start more jobs");
	await runTool(inside, { id: "4", name: "job_update", input: { step: "Checked Eurowings", done: 7, total: 6 } }, newEffects());
	await runTool(inside, { id: "5", name: "ask_user", input: { question: "Which day?", options: ["Thursday", "Friday", "", "Saturday", "Sunday"] } }, newEffects());
	await runTool(inside, { id: "6", name: "finish_job", input: { result: "Done" } }, newEffects());
	assert.deepEqual(calls, ['update Checked Eurowings {"done":6,"total":6}', "ask Which day? Thursday/Friday/Saturday/Sunday", "finish Done"]);
});

test("a watch looks once, sleeps, and wakes on its time or on a matching email; never at night, and not past a week", async () => {
	const threads = store();
	const job = (input: AskInput) => input.tools!.job!;
	let looks = 0;
	const look = (call: (input: AskInput) => void) => (input: AskInput) => {
		looks++;
		call(input);
		return answer("Checked.");
	};
	const runner = new JobRunner({
		threads,
		ask: async (input) => scripts.shift()!(input),
		notify: async (_thread, text) => void told.push(text),
		runsPerGo: 6,
		// Quiet from 22:30 to 07:00.
		quietUntil: (at) => (at.getHours() >= 22 || at.getHours() < 7 ? new Date(new Date(at).setHours(at.getHours() >= 22 ? 31 : 7, 0, 0, 0)) : at),
	});
	const told: string[] = [];
	const scripts: Array<(input: AskInput) => AskResult> = [
		look((input) => job(input).checkBack({ hours: 3, mailWords: ["DHL", "WGOYED9T8", "x"], note: "shipped 27 Oct" })),
		look((input) => {
			assert.match(input.extra || "", /woken by a new email from DHL Paket: "Ihre Sendung kommt heute"/);
			job(input).checkBack({ hours: 4, mailWords: ["DHL"], tell: "Your Apotheke parcel arrives today." });
		}),
		// A run that forgets to say when: it still sleeps, three hours.
		look(() => {}),
	];
	const thread = runner.start({ title: "Track DHL parcel", instructions: "Tell me when the parcel moves.", origin: "console" });
	await runner.settled();
	assert.equal(looks, 1, "one look, not six in a row");
	let state = threads.get(thread.id)!.job!;
	assert.equal(state.status, "waiting");
	assert.deepEqual(state.wakeWords, ["DHL", "WGOYED9T8"], "words too short to mean anything are dropped");
	assert.match(state.note || "", /^shipped 27 Oct; next look \d\d:\d\d.*, or when an email mentions DHL or WGOYED9T8$/);
	assert.ok(Date.parse(state.watchUntil!) - Date.now() > 6.9 * 86_400_000);

	runner.tick(new Date(Date.now() + 60 * 60_000));
	runner.mailArrived([{ from: "Newsletter", subject: "Angebote der Woche" }]);
	await runner.settled();
	assert.equal(looks, 1, "not due yet, and that email wasn't about it");

	runner.mailArrived([{ from: "DHL Paket", subject: "Ihre Sendung kommt heute" }]);
	await runner.settled();
	assert.equal(looks, 2);
	assert.deepEqual(told, ["Your Apotheke parcel arrives today."]);
	state = threads.get(thread.id)!.job!;
	assert.equal(state.status, "waiting");
	assert.equal(state.wokeBy, undefined);

	runner.tick(new Date(Date.parse(state.wakeAt!) + 1000));
	await runner.settled();
	assert.equal(looks, 3);
	state = threads.get(thread.id)!.job!;
	assert.equal(state.status, "waiting", "a watch that forgot check_back still sleeps");
	const wake = new Date(state.wakeAt!);
	assert.ok(wake.getHours() >= 7 && (wake.getHours() < 22 || (wake.getHours() === 22 && wake.getMinutes() < 30)), "never inside the quiet hours");

	// A week on, the watch ends by itself.
	threads.updateJob(thread.id, { watchUntil: new Date(Date.now() + 60_000).toISOString() });
	scripts.push(look((input) => job(input).checkBack({ hours: 6, mailWords: [] })));
	runner.tick(new Date(Date.parse(state.wakeAt!) + 1000));
	await runner.settled();
	assert.equal(threads.get(thread.id)!.job!.status, "done");
	assert.match(told.at(-1)!, /watched this for a week/);

	// Stopping a sleeping watch works too.
	const other = runner.start({ title: "Price watch", instructions: "Tell me when it drops.", origin: "console" });
	scripts.push(look((input) => job(input).checkBack({ hours: 6, mailWords: ["Bahn"] })));
	await runner.settled();
	assert.equal(runner.stop(other.id), true);
	assert.equal(threads.get(other.id)!.job!.status, "stopped");
	runner.mailArrived([{ from: "Bahn", subject: "Preis gesunken" }]);
	await runner.settled();
	assert.equal(looks, 5, "a stopped watch doesn't wake");
});
