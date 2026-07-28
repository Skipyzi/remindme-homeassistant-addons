import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { HostVaultError } from "../src/hostVaultTypes.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { SafetyService } from "../src/safety.js";
import { SearchService } from "../src/search.js";
import { createApp } from "../src/server.js";
import { StorageScanner } from "../src/storageScanner.js";
import { StorageScanService } from "../src/storageScanService.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let hostDirectory: string;
let authorize: ReturnType<typeof vi.fn>;
let storageScans: StorageScanService;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  fixture = await createFixtureRoots();
  hostDirectory = await mkdtemp(path.join(os.tmpdir(), "file-explorer-host-"));
  await mkdir(path.join(hostDirectory, "etc"));
  await writeFile(path.join(hostDirectory, "etc", "os-release"), "NAME=Home Assistant OS\n");
  const roots = createRootRegistry(fixture.config, { hostPath: hostDirectory });
  const policy = new PathPolicy(roots, fixture.protectedPaths);
  authorize = vi.fn((token: string | undefined) => {
    if (token !== "host-token") throw new HostVaultError("VAULT_SESSION_INVALID", "Vault session is invalid");
    return { token, expiresAt: Date.now() + 900_000 };
  });
  storageScans = new StorageScanService(policy, new StorageScanner(), fixture.config.storageScan, {
    hostLimits: fixture.config.hostStorageScan,
  });
  const hostVault = {
    authorize,
    status: vi.fn(async (token?: string) => ({
      configured: true,
      state: token === "host-token" ? "unlocked" : "locked",
      connection: null,
      expiresAt: null,
      lockoutRemainingMs: 0,
      mountHealthy: token === "host-token",
    })),
    setup: vi.fn(), unlock: vi.fn(), lock: vi.fn(), reset: vi.fn(),
  };
  app = createApp({ context: {
    config: fixture.config,
    roots,
    policy,
    filesystem: new FilesystemService(),
    safety: new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash")),
    search: new SearchService(fixture.config),
    storageScans,
    hostVault,
  } as never });
});

afterEach(async () => {
  storageScans.dispose();
  await fixture.cleanup();
  await rm(hostDirectory, { recursive: true, force: true });
});

const vaultHeader = { "X-File-Explorer-Vault": "host-token" };

describe("Host root authorization", () => {
  it("lists Host as locked without exposing its mountpoint", async () => {
    const response = await request(app).get("/api/roots").expect(200);
    expect(response.body.roots).toContainEqual({ id: "host", label: "Host /", readOnly: true, locked: true });
    expect(JSON.stringify(response.body)).not.toContain(hostDirectory);
  });

  it("requires the active vault token for every Host read", async () => {
    await request(app).get("/api/entries").query({ root: "host", path: "etc" }).expect(401);
    await request(app).get("/api/entries").set("X-File-Explorer-Vault", "wrong").query({ root: "host", path: "etc" }).expect(401);

    const entries = await request(app).get("/api/entries").set(vaultHeader).query({ root: "host", path: "etc" }).expect(200);
    expect(entries.body.entries).toContainEqual(expect.objectContaining({ name: "os-release", path: "etc/os-release" }));
    const text = await request(app).get("/api/text").set(vaultHeader).query({ root: "host", path: "etc/os-release" }).expect(200);
    expect(text.body.content).toContain("Home Assistant OS");
    const download = await request(app).get("/api/download").set(vaultHeader).query({ root: "host", path: "etc/os-release" }).expect(200);
    expect(download.body.toString("utf8")).toContain("Home Assistant OS");
    const search = await request(app).get("/api/search").set(vaultHeader).query({ root: "host", path: "etc", q: "Home Assistant" }).expect(200);
    expect(search.body.results).toContainEqual(expect.objectContaining({ path: "etc/os-release" }));
    expect(JSON.stringify({ entries: entries.body, text: text.body, search: search.body })).not.toContain(hostDirectory);
  });

  it.each([
    ["create", () => request(app).post("/api/files").set(vaultHeader).send({ root: "host", path: "new", type: "file" })],
    ["upload", () => request(app).put("/api/upload").set(vaultHeader).query({ root: "host", path: "new" }).send("data")],
    ["save", () => request(app).put("/api/text").set(vaultHeader).send({ root: "host", path: "etc/os-release", content: "changed", signature: "x" })],
    ["move", () => request(app).post("/api/move").set(vaultHeader).send({ root: "host", source: "etc/os-release", target: "etc/moved" })],
    ["trash", () => request(app).delete("/api/files").set(vaultHeader).send({ root: "host", path: "etc/os-release" })],
  ])("rejects Host %s mutations as read-only", async (_name, makeRequest) => {
    const response = await makeRequest().expect(403);
    expect(response.body.error).toEqual({ code: "READ_ONLY_ROOT", message: "Root is read-only" });
  });

  it("owns Host storage jobs by the active vault token", async () => {
    const started = await request(app).post("/api/storage-map/scans").set(vaultHeader)
      .send({ root: "host", path: "etc", refresh: false }).expect(202);
    await request(app).get(`/api/storage-map/scans/${started.body.job.id}`).set("X-File-Explorer-Vault", "wrong").expect(401);

    let status: request.Response | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await request(app).get(`/api/storage-map/scans/${started.body.job.id}`).set(vaultHeader);
      if (status.body.job?.resultAvailable) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(status?.body.job.status).toBe("complete");
    const result = await request(app).get(`/api/storage-map/scans/${started.body.job.id}/result`).set(vaultHeader).expect(200);
    expect(result.body.result.requestedPath).toBe("etc");
    expect(result.body.result.totalBytes).toBeGreaterThan(0);
  });

  it("keeps local roots usable while Host is locked", async () => {
    await request(app).get("/api/entries").query({ root: "config", path: "automations" }).expect(200);
    expect(authorize).not.toHaveBeenCalled();
  });
});
