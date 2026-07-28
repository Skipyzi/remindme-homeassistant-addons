import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("route path security", () => {
  const candidates = ["../outside.txt", "/etc/passwd", "C:\\Windows\\win.ini", "%2e%2e/outside.txt"];
  it.each(candidates)("rejects %s through read and mutation routes", async (candidate) => {
    const responses = await Promise.all([
      request(app).get("/api/entries").query({ root: "config", path: candidate }),
      request(app).get("/api/text").query({ root: "config", path: candidate }),
      request(app).post("/api/files").send({ root: "config", path: candidate, type: "file" }),
      request(app).delete("/api/files").send({ root: "config", path: candidate }),
      request(app).post("/api/move").send({ root: "config", source: "automations/morning.yaml", target: candidate }),
    ]);
    for (const response of responses) {
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body.error.code).toBe("PATH_OUTSIDE_ROOT");
    }
  });
});
