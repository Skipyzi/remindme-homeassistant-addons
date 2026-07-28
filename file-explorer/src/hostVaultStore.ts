import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { EncryptedVault } from "./hostVaultTypes.js";
import { HostVaultError, isEncryptedVault } from "./hostVaultTypes.js";

interface HostVaultStoreFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { flag: "wx"; mode: number }): Promise<void>;
  rename(source: string, target: string): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

const nodeFs: HostVaultStoreFs = { readFile, writeFile, rename, rm };

export class HostVaultStore {
  constructor(
    private readonly vaultPath: string,
    private readonly fs: HostVaultStoreFs = nodeFs,
  ) {}

  async read(): Promise<EncryptedVault | null> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.vaultPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isEncryptedVault(parsed)) throw new Error("Invalid schema");
      return parsed;
    } catch {
      throw new HostVaultError("INVALID_VAULT_CONFIG", "Host Vault configuration is invalid");
    }
  }

  async write(vault: EncryptedVault): Promise<void> {
    if (!isEncryptedVault(vault)) throw new HostVaultError("INVALID_VAULT_CONFIG", "Host Vault configuration is invalid");
    const temporaryPath = `${this.vaultPath}.${randomUUID()}.tmp`;
    try {
      await this.fs.writeFile(temporaryPath, `${JSON.stringify(vault, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await this.fs.rename(temporaryPath, this.vaultPath);
    } finally {
      await this.fs.rm(temporaryPath, { force: true });
    }
  }

  async remove(): Promise<void> {
    await this.fs.rm(this.vaultPath, { force: true });
  }
}
