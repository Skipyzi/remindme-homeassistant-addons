export interface HostConnectionMetadata {
  host: string;
  port: number;
  username: string;
  fingerprint: string;
}

export interface EncryptedVault extends HostConnectionMetadata {
  version: 1;
  kdf: {
    name: "scrypt";
    N: 32768;
    r: 8;
    p: 1;
    maxmem: 67108864;
  };
  salt: string;
  nonce: string;
  ciphertext: string;
  authTag: string;
}

export type HostVaultErrorCode =
  | "INVALID_VAULT_CONFIG"
  | "INVALID_VAULT_PASSPHRASE"
  | "INVALID_VAULT_SETUP"
  | "VAULT_LOCKED_OUT"
  | "VAULT_NOT_CONFIGURED"
  | "VAULT_SESSION_INVALID"
  | "FUSE_UNAVAILABLE"
  | "HOST_KEY_MISMATCH"
  | "SSH_UNAVAILABLE"
  | "HOST_MOUNT_FAILED";

export class HostVaultError extends Error {
  constructor(public readonly code: HostVaultErrorCode, message: string) {
    super(message);
    this.name = "HostVaultError";
  }
}

export function isEncryptedVault(value: unknown): value is EncryptedVault {
  if (!value || typeof value !== "object") return false;
  const vault = value as Partial<EncryptedVault>;
  return vault.version === 1
    && typeof vault.host === "string" && vault.host.length > 0
    && Number.isInteger(vault.port) && Number(vault.port) >= 1 && Number(vault.port) <= 65535
    && typeof vault.username === "string" && vault.username.length > 0
    && typeof vault.fingerprint === "string" && vault.fingerprint.startsWith("SHA256:")
    && vault.kdf?.name === "scrypt"
    && vault.kdf.N === 32768
    && vault.kdf.r === 8
    && vault.kdf.p === 1
    && vault.kdf.maxmem === 67_108_864
    && [vault.salt, vault.nonce, vault.ciphertext, vault.authTag]
      .every((field) => typeof field === "string" && field.length > 0);
}
