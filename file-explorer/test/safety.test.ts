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
let safety: SafetyService;

beforeEach(async () => {
  fixture = await createFixtureRoots();
  const roots = createRootRegistry(fixture.config);
  safety = new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash"));
  app = createApp({ context: {
    config: fixture.config, roots,
    policy: new PathPolicy(roots, fixture.protectedPaths),
    filesystem: new FilesystemService(),
    safety,
  } });
});
afterEach(async () => fixture.cleanup());

describe("uploads and trash", () => {
  it("streams an upload into an authorized destination", async () => {
    await request(app).post("/api/files").send({ root: "config", path: "uploads", type: "directory" }).expect(201);
    const response = await request(app)
      .put("/api/upload?root=config&path=uploads/demo.bin")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from([1, 2, 3, 4]));
    expect(response.status).toBe(201);
    expect(await readFile(path.join(fixture.configRoot, "uploads", "demo.bin"))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect((await readdir(path.join(fixture.configRoot, "uploads"))).some((name) => name.includes(".tmp"))).toBe(false);
  });

  it("rejects oversized uploads and removes temporary files", async () => {
    fixture.config.uploadMaxBytes = 3;
    const response = await request(app)
      .put("/api/upload?root=config&path=large.bin")
      .set("content-type", "application/octet-stream")
      .send(Buffer.from([1, 2, 3, 4]));
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("TOO_LARGE");
    expect((await readdir(fixture.configRoot)).some((name) => name.includes("file-explorer"))).toBe(false);
  });

  it("moves a file to trash and restores it", async () => {
    const removed = await request(app).delete("/api/files").send({ root: "config", path: "automations/morning.yaml" });
    expect(removed.status).toBe(200);
    expect(JSON.stringify(removed.body)).not.toContain(fixture.base);
    const listing = await request(app).get("/api/trash");
    expect(listing.body.items).toHaveLength(1);
    await request(app).post(`/api/trash/${removed.body.trash.id}/restore`).send({}).expect(200);
    expect(await readFile(path.join(fixture.configRoot, "automations", "morning.yaml"), "utf8")).toBe("alias: Morning\n");
  });

  it("requires an alternate path when restore conflicts", async () => {
    const removed = await request(app).delete("/api/files").send({ root: "config", path: "automations/morning.yaml" });
    await request(app).post("/api/files").send({ root: "config", path: "automations/morning.yaml", type: "file" }).expect(201);
    const conflict = await request(app).post(`/api/trash/${removed.body.trash.id}/restore`).send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("NAME_CONFLICT");
    await request(app).post(`/api/trash/${removed.body.trash.id}/restore`).send({ alternatePath: "automations/recovered.yaml" }).expect(200);
  });

  it("permanently purges a selected trash item", async () => {
    const removed = await request(app).delete("/api/files").send({ root: "config", path: "automations/morning.yaml" });
    await request(app).delete(`/api/trash/${removed.body.trash.id}`).expect(204);
    const listing = await request(app).get("/api/trash");
    expect(listing.body.items).toEqual([]);
  });

  it("purges trash records older than the retention period", async () => {
    const removed = await request(app).delete("/api/files").send({ root: "config", path: "automations/morning.yaml" });
    const manifestPath = path.join(fixture.dataDir, "trash", removed.body.trash.id, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.deletedAt = new Date(Date.now() - 40 * 86_400_000).toISOString();
    await writeFile(manifestPath, JSON.stringify(manifest));
    await safety.purgeExpired(30);
    expect(await safety.listTrash()).toEqual([]);
  });
});
