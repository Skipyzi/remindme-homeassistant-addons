import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import type { EncryptedVault, HostConnectionMetadata } from "./hostVaultTypes.js";
import { HostVaultError } from "./hostVaultTypes.js";

const KDF = Object.freeze({ name: "scrypt" as const, N: 32768 as const, r: 8 as const, p: 1 as const, maxmem: 67_108_864 as const });

function normalizeMetadata(metadata: HostConnectionMetadata): HostConnectionMetadata {
  const fingerprint = metadata.fingerprint.trim();
  if (!metadata.host.trim() || !metadata.username.trim() || !Number.isInteger(metadata.port) || metadata.port < 1 || metadata.port > 65535) {
    throw new HostVaultError("INVALID_VAULT_SETUP", "Invalid Host connection settings");
  }
  if (!/^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(fingerprint)) {
    throw new HostVaultError("INVALID_VAULT_SETUP", "Invalid SHA-256 host-key fingerprint");
  }
  return {
    host: metadata.host.trim(),
    port: metadata.port,
    username: metadata.username.trim(),
    fingerprint,
  };
}

function additionalData(vault: Pick<EncryptedVault, "version" | "host" | "port" | "username" | "fingerprint" | "kdf">): Buffer {
  return Buffer.from(JSON.stringify({
    version: vault.version,
    host: vault.host,
    port: vault.port,
    username: vault.username,
    fingerprint: vault.fingerprint,
    kdf: vault.kdf,
  }));
}

function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(passphrase, salt, 32, KDF, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

export async function encryptPrivateKey(
  privateKey: string | Buffer,
  passphrase: string,
  connection: HostConnectionMetadata,
): Promise<EncryptedVault> {
  if (passphrase.length < 12) throw new HostVaultError("INVALID_VAULT_SETUP", "Vault passphrase must contain at least 12 characters");
  const metadata = normalizeMetadata(connection);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  try {
    const base: Omit<EncryptedVault, "ciphertext" | "authTag"> = {
      version: 1,
      kdf: KDF,
      ...metadata,
      salt: salt.toString("base64"),
      nonce: nonce.toString("base64"),
    };
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(additionalData(base));
    const ciphertext = Buffer.concat([cipher.update(privateKey), cipher.final()]);
    return {
      ...base,
      ciphertext: ciphertext.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    key.fill(0);
  }
}

export async function decryptPrivateKey(vault: EncryptedVault, passphrase: string): Promise<Buffer> {
  let key: Buffer | undefined;
  try {
    key = await deriveKey(passphrase, Buffer.from(vault.salt, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(vault.nonce, "base64"));
    decipher.setAAD(additionalData(vault));
    decipher.setAuthTag(Buffer.from(vault.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(vault.ciphertext, "base64")),
      decipher.final(),
    ]);
  } catch {
    throw new HostVaultError("INVALID_VAULT_PASSPHRASE", "Invalid vault passphrase");
  } finally {
    key?.fill(0);
  }
}
