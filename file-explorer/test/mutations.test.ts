import path from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { SafetyService } from "../src/safety.js";
import { createApp } from "../src/server.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let app: ReturnType<typeof createApp>;
let filePath: string;
let storageScans: { invalidate: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  fixture = await createFixtureRoots();
  const roots = createRootRegistry(fixture.config);
  filePath = path.join(fixture.configRoot, "automations", "morning.yaml");
  storageScans = { invalidate: vi.fn() };
  app = createApp({ context: {
    config: fixture.config,
    roots,
    policy: new PathPolicy(roots, fixture.protectedPaths),
    filesystem: new FilesystemService(),
    safety: new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash")),
    storageScans,
  } as never });
});
afterEach(async () => fixture.cleanup());

describe("mutation API", () => {
  it("creates files and directories without replacing existing entries", async () => {
    await request(app).post("/api/files").send({ root: "config", path: "notes", type: "directory" }).expect(201);
    await request(app).post("/api/files").send({ root: "config", path: "notes/home.txt", type: "file" }).expect(201);
    const conflict = await request(app).post("/api/files").send({ root: "config", path: "notes/home.txt", type: "file" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("NAME_CONFLICT");
    expect(storageScans.invalidate).toHaveBeenCalledTimes(2);
    expect(storageScans.invalidate).toHaveBeenLastCalledWith("config");
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
    expect(storageScans.invalidate).toHaveBeenCalledWith("config");
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
    expect(storageScans.invalidate).not.toHaveBeenCalled();
  });

  it("moves and renames entries", async () => {
    const response = await request(app).post("/api/move").send({
      root: "config", source: "automations/morning.yaml", target: "automations/dawn.yaml",
    });
    expect(response.status).toBe(200);
    expect(await readFile(path.join(fixture.configRoot, "automations", "dawn.yaml"), "utf8")).toBe("alias: Morning\n");
    expect(storageScans.invalidate).toHaveBeenCalledWith("config");
  });

  it("invalidates after uploads, trash, restore, and purge", async () => {
    await request(app)
      .put("/api/upload?root=config&path=upload.txt")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from("uploaded"))
      .expect(201);
    expect(storageScans.invalidate).toHaveBeenLastCalledWith("config");

    const removed = await request(app)
      .delete("/api/files")
      .send({ root: "config", path: "upload.txt" })
      .expect(200);
    expect(storageScans.invalidate).toHaveBeenLastCalledWith("config");

    await request(app).post(`/api/trash/${removed.body.trash.id}/restore`).send({}).expect(200);
    expect(storageScans.invalidate).toHaveBeenLastCalledWith("config");

    const removedAgain = await request(app)
      .delete("/api/files")
      .send({ root: "config", path: "upload.txt" })
      .expect(200);
    await request(app).delete(`/api/trash/${removedAgain.body.trash.id}`).expect(204);
    expect(storageScans.invalidate).toHaveBeenCalledTimes(5);
  });
});
