import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { SafetyService } from "../src/safety.js";
import { createApp } from "../src/server.js";
import { StorageScanner } from "../src/storageScanner.js";
import { StorageScanService } from "../src/storageScanService.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let storageScans: StorageScanService;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  fixture = await createFixtureRoots();
  const roots = createRootRegistry(fixture.config);
  const policy = new PathPolicy(roots, fixture.protectedPaths);
  storageScans = new StorageScanService(policy, new StorageScanner(), fixture.config.storageScan);
  app = createApp({ context: {
    config: fixture.config,
    roots,
    policy,
    filesystem: new FilesystemService(),
    safety: new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash")),
    storageScans,
  } });
});

afterEach(async () => {
  storageScans.dispose();
  await fixture.cleanup();
});

async function waitForTerminalStatus(jobId: string) {
  let last: request.Response | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    last = await request(app).get(`/api/storage-map/scans/${jobId}`);
    if (["complete", "partial", "cancelled", "failed"].includes(last.body.job?.status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Scan did not finish: ${JSON.stringify(last?.body)}`);
}

describe("storage map API", () => {
  it("starts, polls, and retrieves a root-relative scan", async () => {
    const started = await request(app)
      .post("/api/storage-map/scans")
      .send({ root: "config", refresh: false })
      .expect(202);
    expect(started.body.job.id).toMatch(/^[0-9a-f-]+$/i);

    const status = await waitForTerminalStatus(started.body.job.id);
    expect(["complete", "partial"]).toContain(status.body.job.status);
    const result = await request(app)
      .get(`/api/storage-map/scans/${started.body.job.id}/result`)
      .query({ path: "" })
      .expect(200);
    expect(result.body.result.totalFiles).toBeGreaterThan(0);
    expect(JSON.stringify(result.body)).not.toContain(fixture.base);
  });

  it("rejects disabled roots, unknown jobs, and escaping result paths", async () => {
    await request(app).post("/api/storage-map/scans").send({ root: "share" }).expect(404);
    await request(app).get("/api/storage-map/scans/not-a-job").expect(404);

    const started = await request(app).post("/api/storage-map/scans").send({ root: "config" }).expect(202);
    await waitForTerminalStatus(started.body.job.id);
    await request(app)
      .get(`/api/storage-map/scans/${started.body.job.id}/result`)
      .query({ path: "../outside" })
      .expect(400);
  });

  it("cancels idempotently", async () => {
    const started = await request(app).post("/api/storage-map/scans").send({ root: "config" }).expect(202);
    await request(app).delete(`/api/storage-map/scans/${started.body.job.id}`).expect(204);
    await request(app).delete(`/api/storage-map/scans/${started.body.job.id}`).expect(204);
  });
});
