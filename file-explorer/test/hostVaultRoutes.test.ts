import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { HostVaultError } from "../src/hostVaultTypes.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { SafetyService } from "../src/safety.js";
import { createApp } from "../src/server.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let hostVault: {
  status: ReturnType<typeof vi.fn>;
  setup: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
  lock: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  fixture = await createFixtureRoots();
  const roots = createRootRegistry(fixture.config);
  hostVault = {
    status: vi.fn(async () => ({ configured: false, state: "unconfigured", connection: null, expiresAt: null, lockoutRemainingMs: 0, mountHealthy: false })),
    setup: vi.fn(async () => undefined),
    unlock: vi.fn(async () => ({ token: "opaque-token", expiresAt: "2026-07-28T10:15:00.000Z" })),
    lock: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  };
  app = createApp({ context: {
    config: fixture.config,
    roots,
    policy: new PathPolicy(roots, fixture.protectedPaths),
    filesystem: new FilesystemService(),
    safety: new SafetyService(path.join(fixture.dataDir, "backups"), path.join(fixture.dataDir, "trash")),
    hostVault,
  } as never });
});

afterEach(async () => fixture.cleanup());

describe("Host Vault API", () => {
  it("returns only safe status fields", async () => {
    const response = await request(app).get("/api/host-vault/status").expect(200);
    expect(response.body).toEqual({ configured: false, state: "unconfigured", connection: null, expiresAt: null, lockoutRemainingMs: 0, mountHealthy: false });
    expect(JSON.stringify(response.body)).not.toContain("ciphertext");
  });

  it("validates and submits setup without reflecting secrets", async () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE ROUTE MARKER\n-----END OPENSSH PRIVATE KEY-----";
    const response = await request(app).post("/api/host-vault/setup").send({
      host: "172.30.32.1",
      port: 22222,
      username: "root",
      fingerprint: "SHA256:ZmFrZS1maW5nZXJwcmludA",
      privateKey,
      passphrase: "vault route phrase",
      passphraseConfirmation: "vault route phrase",
    }).expect(204);

    expect(hostVault.setup).toHaveBeenCalledWith(expect.objectContaining({ privateKey, passphrase: "vault route phrase" }));
    expect(response.text).not.toContain("PRIVATE ROUTE MARKER");
    expect(response.text).not.toContain("vault route phrase");
  });

  it("unlocks and requires the vault header to lock", async () => {
    const unlocked = await request(app).post("/api/host-vault/unlock").send({ passphrase: "vault route phrase" }).expect(200);
    expect(unlocked.body).toEqual({ token: "opaque-token", expiresAt: "2026-07-28T10:15:00.000Z" });

    await request(app).post("/api/host-vault/lock").set("X-File-Explorer-Vault", "opaque-token").expect(204);
    expect(hostVault.lock).toHaveBeenCalledWith("opaque-token");
  });

  it("maps invalid passphrases and lockout to stable safe responses", async () => {
    hostVault.unlock.mockRejectedValueOnce(new HostVaultError("INVALID_VAULT_PASSPHRASE", "Invalid vault passphrase"));
    await request(app).post("/api/host-vault/unlock").send({ passphrase: "wrong route secret" })
      .expect(401, { error: { code: "INVALID_VAULT_PASSPHRASE", message: "Invalid vault passphrase" } });

    hostVault.unlock.mockRejectedValueOnce(new HostVaultError("VAULT_LOCKED_OUT", "Host Vault unlock is temporarily locked"));
    hostVault.status.mockResolvedValueOnce({ configured: true, state: "locked", connection: null, expiresAt: null, lockoutRemainingMs: 31_000, mountHealthy: false });
    const locked = await request(app).post("/api/host-vault/unlock").send({ passphrase: "wrong route secret" }).expect(429);
    expect(locked.headers["retry-after"]).toBe("31");
    expect(JSON.stringify(locked.body)).not.toContain("wrong route secret");
  });

  it("requires exact destructive reset confirmation", async () => {
    await request(app).delete("/api/host-vault").send({ confirmation: "RESET HOST VAULT" }).expect(204);
    expect(hostVault.reset).toHaveBeenCalledWith("RESET HOST VAULT");
  });
});
