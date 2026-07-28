import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptPrivateKey } from "../src/hostVaultCrypto.js";
import { HostVaultStore } from "../src/hostVaultStore.js";

const created: string[] = [];
const metadata = {
  host: "172.30.32.1",
  port: 22222,
  username: "root",
  fingerprint: "SHA256:ZmFrZS1maW5nZXJwcmludA",
};

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-vault-store-"));
  created.push(directory);
  return { directory, vaultPath: path.join(directory, "host-vault.json") };
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("HostVaultStore", () => {
  it("atomically persists and reads encrypted configuration without plaintext", async () => {
    const { vaultPath } = await fixture();
    const store = new HostVaultStore(vaultPath);
    const vault = await encryptPrivateKey("PRIVATE KEY SECRET", "vault phrase", metadata);

    await store.write(vault);

    await expect(store.read()).resolves.toEqual(vault);
    expect(await readFile(vaultPath, "utf8")).not.toContain("PRIVATE KEY SECRET");
    if (process.platform !== "win32") expect((await stat(vaultPath)).mode & 0o777).toBe(0o600);
  });

  it("returns null when unconfigured and removes an existing vault", async () => {
    const { vaultPath } = await fixture();
    const store = new HostVaultStore(vaultPath);

    await expect(store.read()).resolves.toBeNull();
    await store.write(await encryptPrivateKey("KEY", "vault phrase", metadata));
    await store.remove();
    await expect(store.read()).resolves.toBeNull();
  });

  it("keeps the previous vault when replacement fails and removes temporary files", async () => {
    const { directory, vaultPath } = await fixture();
    const first = await encryptPrivateKey("FIRST KEY", "vault phrase", metadata);
    const second = await encryptPrivateKey("SECOND KEY", "vault phrase", metadata);
    const store = new HostVaultStore(vaultPath);
    await store.write(first);
    const failingStore = new HostVaultStore(vaultPath, {
      writeFile,
      readFile,
      rename: vi.fn(async () => { throw new Error("rename failed"); }),
      rm,
    });

    await expect(failingStore.write(second)).rejects.toThrow("rename failed");

    await expect(store.read()).resolves.toEqual(first);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("rejects malformed persisted JSON", async () => {
    const { vaultPath } = await fixture();
    await writeFile(vaultPath, JSON.stringify({ version: 99 }));
    await expect(new HostVaultStore(vaultPath).read()).rejects.toMatchObject({ code: "INVALID_VAULT_CONFIG" });
  });
});
