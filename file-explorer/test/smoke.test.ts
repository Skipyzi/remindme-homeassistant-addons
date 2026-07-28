import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { SafetyService } from "../src/safety.js";
import { SearchService } from "../src/search.js";
import { createApp } from "../src/server.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let app: ReturnType<typeof createApp>;
beforeEach(async () => {
  fixture = await createFixtureRoots(); const roots = createRootRegistry(fixture.config);
  app = createApp({ context: { config: fixture.config, roots, policy: new PathPolicy(roots, fixture.protectedPaths), filesystem: new FilesystemService(), safety: new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash")), search: new SearchService(fixture.config) } });
});
afterEach(async () => fixture.cleanup());

it("completes the v1 file lifecycle", async () => {
  await request(app).post("/api/files").send({ root: "config", path: "notes", type: "directory" }).expect(201);
  await request(app).post("/api/files").send({ root: "config", path: "notes/home.txt", type: "file" }).expect(201);
  const opened = await request(app).get("/api/text").query({ root: "config", path: "notes/home.txt" }).expect(200);
  await request(app).put("/api/text").send({ root: "config", path: "notes/home.txt", content: "kitchen morning", signature: opened.body.signature }).expect(200);
  await request(app).post("/api/move").send({ root: "config", source: "notes/home.txt", target: "notes/routine.txt" }).expect(200);
  const search = await request(app).get("/api/search").query({ root: "config", path: "", q: "morning" }).expect(200);
  expect(search.body.results.some((item: { path: string }) => item.path === "notes/routine.txt")).toBe(true);
  const removed = await request(app).delete("/api/files").send({ root: "config", path: "notes/routine.txt" }).expect(200);
  await request(app).post(`/api/trash/${removed.body.trash.id}/restore`).send({}).expect(200);
  const downloaded = await request(app).get("/api/download").query({ root: "config", path: "notes/routine.txt" }).expect(200);
  expect(downloaded.text).toBe("kitchen morning");
});
