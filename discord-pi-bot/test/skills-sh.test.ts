import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillStore, skillPrompt } from "../src/harness/skills.ts";
import { SkillsSh, locateSkill, needsScripts, parseSkillId, parseSkillMd } from "../src/harness/skills-sh.ts";
import { buildTools, newEffects, runTool } from "../src/assistant/tools.ts";

const humanizer = `---
name: humanizer
description: |
  Rewrite AI-sounding text so it reads like the writer.
  Use when editing prose for AI tells.
license: MIT
---

# Humanizer

${"Cut the filler. ".repeat(200)}`;

test("a SKILL.md's header and instructions are read apart", () => {
	const skill = parseSkillMd(humanizer);
	assert.equal(skill.name, "humanizer");
	assert.equal(skill.description, "Rewrite AI-sounding text so it reads like the writer. Use when editing prose for AI tells.");
	assert.equal(skill.license, "MIT");
	assert.match(skill.body, /^# Humanizer/);
	assert.equal(parseSkillMd('---\nname: "summarize"\ndescription: "Summarize URLs."\n---\nDo it.').description, "Summarize URLs.");
	assert.equal(parseSkillMd("Just text").body, "Just text");
});

test("skills.sh ids name a GitHub repository; others are left out", () => {
	assert.deepEqual(parseSkillId("blader/humanizer/humanizer"), { repo: "blader/humanizer", skill: "humanizer" });
	assert.equal(parseSkillId("open.feishu.cn/lark-calendar"), undefined);
	assert.equal(parseSkillId("../../etc/passwd"), undefined);
});

test("a skill's folder is found in its repository, and code beside it is noticed", () => {
	const tree = ["README.md", "dist/skills/travel-planner/SKILL.md", "packages/skills/travel-planner/SKILL.md", "packages/skills/travel-planner/scripts/plan.py", "packages/skills/travel-planner/references/tips.md", "skills/other/SKILL.md"];
	assert.deepEqual(locateSkill(tree, "travel-planner"), { path: "packages/skills/travel-planner/SKILL.md", code: ["scripts/plan.py"] });
	assert.deepEqual(locateSkill(["SKILL.md", "README.md", "scripts/validate-package.py"], "humanizer"), { path: "SKILL.md", code: ["scripts/validate-package.py"] });
	assert.deepEqual(locateSkill(["skills/writing/SKILL.md", "skills/writing/examples.md"], "writing"), { path: "skills/writing/SKILL.md", code: [] });
	assert.equal(needsScripts("Run `python scripts/plan.py --city Rome`.", ["scripts/plan.py"]), true);
	assert.equal(needsScripts("Rewrite the text plainly.", ["scripts/validate-package.py"]), false, "the repository's own tooling");
	assert.equal(locateSkill(["skills/other/SKILL.md"], "writing"), undefined);
});

test("search finds skills on GitHub with what each is for; preview reads the SKILL.md", async () => {
	const asked: string[] = [];
	const fake = (async (url: string) => {
		asked.push(url);
		if (url.startsWith("https://skills.sh/api/search")) return Response.json({ skills: [{ id: "blader/humanizer/humanizer", name: "humanizer", installs: 11259 }, { id: "open.feishu.cn/lark-x", name: "lark-x", installs: 9 }] });
		if (url === "https://skills.sh/blader/humanizer/humanizer") return new Response('<html><meta name="description" content="Rewrite AI-sounding text &amp; keep the meaning…"/></html>');
		if (url.startsWith("https://api.github.com/repos/blader/humanizer/git/trees/HEAD")) return Response.json({ tree: [{ path: "SKILL.md", type: "blob" }, { path: "README.md", type: "blob" }] });
		if (url === "https://raw.githubusercontent.com/blader/humanizer/HEAD/SKILL.md") return new Response(humanizer);
		return new Response("", { status: 404 });
	}) as unknown as typeof fetch;
	const skillsSh = new SkillsSh(fake);
	const found = await skillsSh.search("humanizer");
	assert.deepEqual(found, [{ id: "blader/humanizer/humanizer", name: "humanizer", repo: "blader/humanizer", installs: 11259, description: "Rewrite AI-sounding text & keep the meaning…" }]);
	const preview = await skillsSh.preview("blader/humanizer/humanizer");
	assert.equal(preview.path, "SKILL.md");
	assert.equal(preview.scripts, false);
	assert.equal(preview.url, "https://github.com/blader/humanizer/blob/HEAD/SKILL.md");
	assert.ok(preview.size > 800);
	assert.deepEqual(await skillsSh.search("a"), [], "too short to search");
	await assert.rejects(skillsSh.preview("nobody/nothing/missing"), /couldn't find|isn't on GitHub/);
});

test("short skills ride along with every message; long ones are listed and read with use_skill", async () => {
	const store = new SkillStore(join(mkdtempSync(join(tmpdir(), "skills-")), "skills.json"));
	await store.create({ name: "Short replies", instructions: "Two sentences unless asked." });
	const long = await store.create({ name: "humanizer", description: "Rewrite AI-sounding text.", instructions: parseSkillMd(humanizer).body, source: { kind: "skills.sh", id: "blader/humanizer/humanizer", repo: "blader/humanizer", path: "SKILL.md", url: "https://github.com/blader/humanizer" } });
	await store.create({ name: "Off one", instructions: "x".repeat(900), enabled: false });
	assert.ok(long.instructions.length > 2000, "imported skills aren't cut at the old 2,000 characters");
	const prompt = skillPrompt(store.enabled());
	assert.match(prompt, /- Short replies: Two sentences unless asked\./);
	assert.match(prompt, /call use_skill with its name first/);
	assert.match(prompt, /- humanizer: Rewrite AI-sounding text\./);
	assert.ok(!prompt.includes("Cut the filler"), "a long skill's text stays out of every message");
	assert.ok(!prompt.includes("Off one"));

	const tools = await buildTools(
		{
			confirmations: {} as never,
			reminders: {} as never,
			skills: {
				names: () => ["humanizer"],
				read: (name) => {
					const skill = store.find(name);
					return skill ? { name: skill.name, instructions: skill.instructions } : undefined;
				},
			},
		},
		{ nativeWebSearch: true },
	);
	const used = await runTool(tools, { id: "1", name: "use_skill", input: { name: "Humanizer" } }, newEffects());
	assert.match(String(used.content), /^Skill "humanizer":\n\n# Humanizer/);
	const missing = await runTool(tools, { id: "2", name: "use_skill", input: { name: "Off one" } }, newEffects());
	assert.equal(missing.isError, true);
});
