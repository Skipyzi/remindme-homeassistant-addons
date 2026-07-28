import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { SafetyService } from "../src/safety.js";
import { createApp } from "../src/server.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let app: ReturnType<typeof createApp>;
let filePath: string;

beforeEach(async () => {
  fixture = await createFixtureRoots();
  const roots = createRootRegistry(fixture.config);
  filePath = path.join(fixture.configRoot, "automations", "morning.yaml");
  app = createApp({ context: {
    config: fixture.config,
    roots,
    policy: new PathPolicy(roots, fixture.protectedPaths),
    filesystem: new FilesystemService(),
    safety: new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash")),
  } });
});
afterEach(async () => fixture.cleanup());

describe("mutation API", () => {
  it("creates files and directories without replacing existing entries", async () => {
    await request(app).post("/api/files").send({ root: "config", path: "notes", type: "directory" }).expect(201);
    await request(app).post("/api/files").send({ root: "config", path: "notes/home.txt", type: "file" }).expect(201);
    const conflict = await request(app).post("/api/files").send({ root: "config", path: "notes/home.txt", type: "file" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("NAME_CONFLICT");
  });

  it("backs up the old file before an atomic save", async () => {
    const opened = await request(app).get("/api/text").query({ root: "config", path: "automations/morning.yaml" });
    const response = await request(app).put("/api/text").send({
      root: "config", path: "automations/morning.yaml", content: "alias: Updated\n", signature: opened.body.signature,
    });
    expect(response.status).toBe(200);
    expect(await readFile(filePath, "utf8")).toBe("alias: Updated\n");
    const backupFiles = (await readdir(path.join(fixture.dataDir, "backups"))).filter((name) => !name.endsWith(".json"));
    expect(backupFiles).toHaveLength(1);
    expect(await readFile(path.join(fixture.dataDir, "backups", backupFiles[0]), "utf8")).toBe("alias: Morning\n");
    expect(JSON.stringify(response.body)).not.toContain(fixture.base);
  });

  it("refuses stale saves without losing external content", async () => {
    const opened = await request(app).get("/api/text").query({ root: "config", path: "automations/morning.yaml" });
    await writeFile(filePath, "alias: External change with different size\n");
    const response = await request(app).put("/api/text").send({
      root: "config", path: "automations/morning.yaml", content: "alias: Browser\n", signature: opened.body.signature,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("FILE_CHANGED");
    expect(await readFile(filePath, "utf8")).toContain("External change");
  });

  it("moves and renames entries", async () => {
    const response = await request(app).post("/api/move").send({
      root: "config", source: "automations/morning.yaml", target: "automations/dawn.yaml",
    });
    expect(response.status).toBe(200);
    expect(await readFile(path.join(fixture.configRoot, "automations", "dawn.yaml"), "utf8")).toBe("alias: Morning\n");
  });
});
