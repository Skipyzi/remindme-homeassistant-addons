import { describe, expect, it, vi } from "vitest";
import { HostVaultService } from "../src/hostVaultService.js";
import type { EncryptedVault } from "../src/hostVaultTypes.js";
import { HostVaultError } from "../src/hostVaultTypes.js";

const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nkey data\n-----END OPENSSH PRIVATE KEY-----\n";
const vault: EncryptedVault = {
  version: 1,
  host: "172.30.32.1",
  port: 22222,
  username: "root",
  fingerprint: "SHA256:ZmFrZS1maW5nZXJwcmludA",
  kdf: { name: "scrypt", N: 32768, r: 8, p: 1, maxmem: 67_108_864 },
  salt: "c2FsdA==",
  nonce: "bm9uY2U=",
  ciphertext: "Y2lwaGVy",
  authTag: "dGFn",
};

function setup(initial: EncryptedVault | null = vault) {
  let stored = initial;
  let now = 1_000;
  let timerCallback: () => void = () => undefined;
  const handles: Array<{ isAlive: ReturnType<typeof vi.fn>; unmount: ReturnType<typeof vi.fn> }> = [];
  const store = {
    read: vi.fn(async () => stored),
    write: vi.fn(async (next: EncryptedVault) => { stored = next; }),
    remove: vi.fn(async () => { stored = null; }),
  };
  const mount = {
    verifyHost: vi.fn(async () => "/runtime/known_hosts"),
    mount: vi.fn(async () => {
      const handle = { isAlive: vi.fn(() => true), unmount: vi.fn(async () => undefined) };
      handles.push(handle);
      return handle;
    }),
  };
  const runtimeFs = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  };
  const dependencies = {
    encrypt: vi.fn(async () => vault),
    decrypt: vi.fn(async (_vault: EncryptedVault, passphrase: string) => {
      if (passphrase !== "vault phrase") throw new HostVaultError("INVALID_VAULT_PASSPHRASE", "Invalid vault passphrase");
      return Buffer.from(privateKey);
    }),
    tokenFactory: vi.fn(() => "token-1"),
    now: () => now,
    setInterval: vi.fn((callback: () => void) => { timerCallback = callback; return { unref: vi.fn() }; }),
    clearInterval: vi.fn(),
  };
  const service = new HostVaultService({
    store,
    mount,
    runtimeFs,
    runtimeDirectory: "/runtime",
    mountPath: "/host",
    dependencies,
  });
  return {
    service, store, mount, runtimeFs, dependencies, handles,
    advance(milliseconds: number) { now += milliseconds; },
    tick() { timerCallback(); },
  };
}

const setupInput = {
  host: "172.30.32.1",
  port: 22222,
  username: "root",
  fingerprint: "SHA256:ZmFrZS1maW5nZXJwcmludA",
  privateKey,
  passphrase: "vault phrase",
  passphraseConfirmation: "vault phrase",
};

describe("HostVaultService", () => {
  it("mount-tests setup before persisting and removes runtime key material", async () => {
    const fixture = setup(null);

    await fixture.service.setup(setupInput);

    expect(fixture.mount.verifyHost).toHaveBeenCalledWith(expect.objectContaining({ port: 22222 }), "/runtime");
    expect(fixture.runtimeFs.writeFile).toHaveBeenCalledWith("/runtime/id_host", expect.any(Buffer), { mode: 0o600 });
    expect(fixture.handles[0].unmount).toHaveBeenCalled();
    expect(fixture.runtimeFs.rm).toHaveBeenCalledWith("/runtime", { recursive: true, force: true });
    expect(fixture.store.write).toHaveBeenCalledWith(vault);
  });

  it("unlocks one session and replaces a prior session safely", async () => {
    const fixture = setup();
    const first = await fixture.service.unlock("vault phrase");
    expect(first).toEqual({ token: "token-1", expiresAt: new Date(901_000).toISOString() });
    expect(fixture.service.authorize("token-1")).toMatchObject({ token: "token-1" });

    fixture.dependencies.tokenFactory.mockReturnValue("token-2");
    const second = await fixture.service.unlock("vault phrase");

    expect(second.token).toBe("token-2");
    expect(fixture.handles[0].unmount).toHaveBeenCalled();
    expect(() => fixture.service.authorize("token-1")).toThrow("Vault session is invalid");
    expect(fixture.service.authorize("token-2")).toMatchObject({ token: "token-2" });
  });

  it("locks out after five failed passphrases and permits retry after 60 seconds", async () => {
    const fixture = setup();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(fixture.service.unlock("wrong phrase")).rejects.toMatchObject({ code: "INVALID_VAULT_PASSPHRASE" });
    }

    await expect(fixture.service.unlock("vault phrase")).rejects.toMatchObject({ code: "VAULT_LOCKED_OUT" });
    expect(fixture.dependencies.decrypt).toHaveBeenCalledTimes(5);
    fixture.advance(60_001);
    await expect(fixture.service.unlock("vault phrase")).resolves.toMatchObject({ token: "token-1" });
  });

  it("reports unlocked state only to the active browser session", async () => {
    const fixture = setup();
    await fixture.service.unlock("vault phrase");

    expect((await fixture.service.status()).state).toBe("locked");
    expect((await fixture.service.status("token-1")).state).toBe("unlocked");
  });

  it("extends idle expiry only through authorized Host activity", async () => {
    const fixture = setup();
    await fixture.service.unlock("vault phrase");
    fixture.advance(400_000);

    fixture.service.touch("token-1");
    expect((await fixture.service.status("token-1")).expiresAt).toBe(new Date(1_301_000).toISOString());
    fixture.advance(899_999);
    fixture.tick();
    await Promise.resolve();
    expect((await fixture.service.status("token-1")).state).toBe("unlocked");
  });

  it("idle expiry invalidates access, calls lock listeners, unmounts, and erases runtime files", async () => {
    const fixture = setup();
    const onLock = vi.fn();
    fixture.service.onLock(onLock);
    await fixture.service.unlock("vault phrase");
    fixture.advance(900_001);

    fixture.tick();
    await vi.waitFor(() => expect(fixture.handles[0].unmount).toHaveBeenCalled());

    expect(() => fixture.service.authorize("token-1")).toThrow("Vault session is invalid");
    expect(onLock).toHaveBeenCalled();
    expect(fixture.handles[0].unmount).toHaveBeenCalled();
    expect(fixture.runtimeFs.rm).toHaveBeenLastCalledWith("/runtime", { recursive: true, force: true });
  });

  it("locks immediately when the SSHFS process is no longer healthy", async () => {
    const fixture = setup();
    await fixture.service.unlock("vault phrase");
    fixture.handles[0].isAlive.mockReturnValue(false);

    fixture.tick();
    await vi.waitFor(() => expect(fixture.handles[0].unmount).toHaveBeenCalled());

    expect((await fixture.service.status("token-1")).state).toBe("locked");
    expect(() => fixture.service.authorize("token-1")).toThrow("Vault session is invalid");
  });

  it("requires exact reset confirmation and cleans up on dispose", async () => {
    const fixture = setup();
    await fixture.service.unlock("vault phrase");
    await expect(fixture.service.reset("RESET")).rejects.toMatchObject({ code: "INVALID_VAULT_SETUP" });

    await fixture.service.dispose();
    expect(fixture.handles[0].unmount).toHaveBeenCalled();
    expect(fixture.dependencies.clearInterval).toHaveBeenCalled();

    await fixture.service.reset("RESET HOST VAULT");
    expect(fixture.store.remove).toHaveBeenCalled();
  });
});
