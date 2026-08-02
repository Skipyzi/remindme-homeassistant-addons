import path from "node:path";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createFixtureRoots } from "./fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const rejectedPaths = [
  "../outside.txt",
  "../../etc/passwd",
  "/etc/passwd",
  "C:\\Windows\\win.ini",
  "%2e%2e/outside.txt",
  "folder/../../../outside.txt",
];

describe("PathPolicy", () => {
  it.each(rejectedPaths)("rejects escaping path %s", async (candidate) => {
    const fixture = await createFixtureRoots();
    cleanups.push(fixture.cleanup);
    const policy = new PathPolicy(fixture.registry, fixture.protectedPaths);
    await expect(policy.authorize("config", candidate, "read")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
  });

  it("authorizes a regular create path", async () => {
    const fixture = await createFixtureRoots();
    cleanups.push(fixture.cleanup);
    const policy = new PathPolicy(fixture.registry, fixture.protectedPaths);
    const result = await policy.authorize("config", "automations/evening.yaml", "create");
    expect(result.absolutePath).toBe(path.join(fixture.configRoot, "automations", "evening.yaml"));
  });

  it("rejects disabled roots", async () => {
    const fixture = await createFixtureRoots();
    cleanups.push(fixture.cleanup);
    const policy = new PathPolicy(fixture.registry, fixture.protectedPaths);
    await expect(policy.authorize("share", "file.txt", "create")).rejects.toMatchObject({ code: "ROOT_DISABLED" });
  });

  it("rejects a junction whose target leaves the root", async () => {
    const fixture = await createFixtureRoots();
    cleanups.push(fixture.cleanup);
    const outside = path.join(fixture.base, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "private\n");
    await symlink(outside, path.join(fixture.configRoot, "escape"), "junction");
    const policy = new PathPolicy(fixture.registry, fixture.protectedPaths);
    await expect(policy.authorize("config", "escape/secret.txt", "read")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
    await expect(policy.authorize("config", "escape/new.txt", "create")).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ROOT",
    });
  });
});

describe("loadConfig", () => {
  it("reports invalid add-on options clearly", async () => {
    const fixture = await createFixtureRoots();
    cleanups.push(fixture.cleanup);
    const optionsPath = path.join(fixture.base, "invalid-options.json");
    await writeFile(optionsPath, "{invalid");
    await expect(loadConfig(optionsPath, fixture.dataDir)).rejects.toThrow("Add-on options are not valid JSON");
  });

  it("maps enabled Home Assistant roots and limits", async () => {
    const fixture = await createFixtureRoots();
    cleanups.push(fixture.cleanup);
    const optionsPath = path.join(fixture.base, "options.json");
    await writeFile(optionsPath, JSON.stringify({ enable_config: true, enable_share: false, enable_media: true, search_timeout_seconds: 7 }));
    const config = await loadConfig(optionsPath, fixture.dataDir, {
      config: fixture.configRoot,
      share: fixture.shareRoot,
      media: path.join(fixture.base, "media"),
    });
    expect(config.roots.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: "config", enabled: true },
      { id: "share", enabled: false },
      { id: "media", enabled: true },
    ]);
    expect(config.searchTimeoutMs).toBe(7_000);
  });
});
