import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { SafetyService } from "../src/safety.js";
import { safeSearchFailure, SearchService } from "../src/search.js";
import { createApp } from "../src/server.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  fixture = await createFixtureRoots();
  await mkdir(path.join(fixture.configRoot, "scripts"));
  await writeFile(path.join(fixture.configRoot, "scripts", "day.yaml"), "description: morning routine\n");
  await writeFile(path.join(fixture.configRoot, "binary.bin"), Buffer.from([0, 109, 111, 114, 110, 105, 110, 103]));
  const roots = createRootRegistry(fixture.config);
  app = createApp({ context: {
    config: fixture.config, roots,
    policy: new PathPolicy(roots, fixture.protectedPaths),
    filesystem: new FilesystemService(),
    safety: new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash")),
    search: new SearchService(fixture.config),
  } });
});
afterEach(async () => fixture.cleanup());

describe("search API", () => {
  it("sanitizes filesystem failures that may contain Host mount paths", () => {
    expect(safeSearchFailure(new Error("ENOENT: no such file, lstat '/host/etc/secret'"))).toBe("Read failed");
  });
  it("matches names and bounded text content", async () => {
    const response = await request(app).get("/api/search").query({ root: "config", path: "", q: "morning" });
    expect(response.status).toBe(200);
    expect(response.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "automations/morning.yaml", matchedBy: "name" }),
      expect.objectContaining({ path: "scripts/day.yaml", matchedBy: "content" }),
    ]));
    expect(response.body.results.some((item: { path: string }) => item.path === "binary.bin")).toBe(false);
  });

  it("caps results and reports truncation", async () => {
    fixture.config.searchMaxResults = 1;
    const response = await request(app).get("/api/search").query({ root: "config", path: "", q: "yaml" });
    expect(response.status).toBe(200);
    expect(response.body.results).toHaveLength(1);
    expect(response.body.truncated).toBe(true);
  });

  it("rejects empty queries", async () => {
    const response = await request(app).get("/api/search").query({ root: "config", path: "", q: " " });
    expect(response.status).toBe(400);
  });
});
