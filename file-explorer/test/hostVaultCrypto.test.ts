import { describe, expect, it } from "vitest";
import { decryptPrivateKey, encryptPrivateKey } from "../src/hostVaultCrypto.js";
import type { HostConnectionMetadata } from "../src/hostVaultTypes.js";

const metadata: HostConnectionMetadata = {
  host: "172.30.32.1",
  port: 22222,
  username: "root",
  fingerprint: "SHA256:ZmFrZS1maW5nZXJwcmludA",
};
const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY-----\n";

describe("Host Vault cryptography", () => {
  it("round-trips a private key with the specified authenticated schema", async () => {
    const vault = await encryptPrivateKey(privateKey, "vault phrase", metadata);

    await expect(decryptPrivateKey(vault, "vault phrase")).resolves.toEqual(Buffer.from(privateKey));
    expect(vault).toMatchObject({
      version: 1,
      kdf: { name: "scrypt", N: 32768, r: 8, p: 1, maxmem: 67_108_864 },
      ...metadata,
    });
    expect(JSON.stringify(vault)).not.toContain(privateKey);
    expect(JSON.stringify(vault)).not.toContain("vault phrase");
  });

  it("randomizes salts and nonces", async () => {
    const first = await encryptPrivateKey(privateKey, "vault phrase", metadata);
    const second = await encryptPrivateKey(privateKey, "vault phrase", metadata);

    expect(first.salt).not.toBe(second.salt);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects wrong passphrases and authenticated metadata changes safely", async () => {
    const vault = await encryptPrivateKey(privateKey, "vault phrase", metadata);

    await expect(decryptPrivateKey(vault, "wrong phrase")).rejects.toMatchObject({
      code: "INVALID_VAULT_PASSPHRASE",
      message: "Invalid vault passphrase",
    });
    await expect(decryptPrivateKey({ ...vault, host: "changed.invalid" }, "vault phrase"))
      .rejects.toMatchObject({ code: "INVALID_VAULT_PASSPHRASE" });
    await expect(decryptPrivateKey({ ...vault, authTag: Buffer.alloc(16).toString("base64") }, "vault phrase"))
      .rejects.toMatchObject({ code: "INVALID_VAULT_PASSPHRASE" });
  });
});
