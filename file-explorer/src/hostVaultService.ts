import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { decryptPrivateKey, encryptPrivateKey } from "./hostVaultCrypto.js";
import type { HostVaultStore } from "./hostVaultStore.js";
import type { EncryptedVault, HostConnectionMetadata } from "./hostVaultTypes.js";
import { HostVaultError } from "./hostVaultTypes.js";
import type { SshfsMountAdapter, SshfsMountHandle } from "./sshfsMount.js";

interface VaultStoreLike extends Pick<HostVaultStore, "read" | "write" | "remove"> {}
interface MountAdapterLike extends Pick<SshfsMountAdapter, "verifyHost" | "mount"> {}
interface RuntimeFs {
  mkdir(targetPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(targetPath: string, data: Buffer, options: { mode: number }): Promise<void>;
  rm(targetPath: string, options: { recursive: true; force: true }): Promise<void>;
}
interface TimerHandle { unref?(): void }
interface ServiceDependencies {
  encrypt(privateKey: string | Buffer, passphrase: string, metadata: HostConnectionMetadata): Promise<EncryptedVault>;
  decrypt(vault: EncryptedVault, passphrase: string): Promise<Buffer>;
  tokenFactory(): string;
  now(): number;
  setInterval(callback: () => void, milliseconds: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface HostVaultSetupInput extends HostConnectionMetadata {
  privateKey: string;
  passphrase: string;
  passphraseConfirmation: string;
}

export interface HostVaultSession {
  token: string;
  expiresAt: number;
}

export interface HostVaultStatus {
  configured: boolean;
  state: "unconfigured" | "locked" | "unlocked";
  connection: HostConnectionMetadata | null;
  expiresAt: string | null;
  lockoutRemainingMs: number;
  mountHealthy: boolean;
}

const nodeRuntimeFs: RuntimeFs = { mkdir, writeFile, rm };
const nodeDependencies: ServiceDependencies = {
  encrypt: encryptPrivateKey,
  decrypt: decryptPrivateKey,
  tokenFactory: () => randomBytes(32).toString("base64url"),
  now: Date.now,
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export class HostVaultService {
  private readonly lockListeners = new Set<() => void | Promise<void>>();
  private readonly timer: TimerHandle;
  private operation: Promise<void> = Promise.resolve();
  private session: HostVaultSession | null = null;
  private mountHandle: SshfsMountHandle | null = null;
  private connection: HostConnectionMetadata | null = null;
  private failedUnlocks = 0;
  private lockoutUntil = 0;

  constructor(private readonly options: {
    store: VaultStoreLike;
    mount: MountAdapterLike;
    runtimeFs?: RuntimeFs;
    runtimeDirectory: string;
    mountPath: string;
    dependencies?: ServiceDependencies;
  }) {
    this.runtimeFs = options.runtimeFs ?? nodeRuntimeFs;
    this.dependencies = options.dependencies ?? nodeDependencies;
    this.timer = this.dependencies.setInterval(() => {
      void this.serialized(async () => {
        if (this.session && (this.dependencies.now() >= this.session.expiresAt || !this.mountHandle?.isAlive())) {
          await this.lockInternal();
        }
      });
    }, 5_000);
    this.timer.unref?.();
  }

  private readonly runtimeFs: RuntimeFs;
  private readonly dependencies: ServiceDependencies;

  async setup(input: HostVaultSetupInput): Promise<void> {
    return this.serialized(async () => {
      if (input.passphrase !== input.passphraseConfirmation) {
        throw new HostVaultError("INVALID_VAULT_SETUP", "Vault passphrases do not match");
      }
      if (!input.privateKey.includes("-----BEGIN OPENSSH PRIVATE KEY-----") || !input.privateKey.includes("-----END OPENSSH PRIVATE KEY-----")) {
        throw new HostVaultError("INVALID_VAULT_SETUP", "A valid OpenSSH private key is required");
      }
      if (this.session) await this.lockInternal();
      const metadata: HostConnectionMetadata = {
        host: input.host,
        port: input.port,
        username: input.username,
        fingerprint: input.fingerprint,
      };
      const encrypted = await this.dependencies.encrypt(input.privateKey, input.passphrase, metadata);
      const key = Buffer.from(input.privateKey);
      let testMount: SshfsMountHandle | null = null;
      try {
        const keyPath = await this.writeRuntimeKey(key);
        const knownHostsPath = await this.options.mount.verifyHost(metadata, this.options.runtimeDirectory);
        testMount = await this.options.mount.mount(metadata, keyPath, knownHostsPath, this.options.mountPath);
        await testMount.unmount();
        testMount = null;
        await this.runtimeFs.rm(this.options.runtimeDirectory, { recursive: true, force: true });
        await this.options.store.write(encrypted);
        this.connection = metadata;
        this.failedUnlocks = 0;
        this.lockoutUntil = 0;
      } finally {
        key.fill(0);
        await testMount?.unmount();
        await this.runtimeFs.rm(this.options.runtimeDirectory, { recursive: true, force: true });
      }
    });
  }

  async unlock(passphrase: string): Promise<{ token: string; expiresAt: string }> {
    return this.serialized(async () => {
      const now = this.dependencies.now();
      if (now < this.lockoutUntil) throw new HostVaultError("VAULT_LOCKED_OUT", "Host Vault unlock is temporarily locked");
      if (this.session) await this.lockInternal();
      const vault = await this.options.store.read();
      if (!vault) throw new HostVaultError("VAULT_NOT_CONFIGURED", "Host Vault is not configured");
      let key: Buffer;
      try {
        key = await this.dependencies.decrypt(vault, passphrase);
      } catch (error) {
        if (error instanceof HostVaultError && error.code === "INVALID_VAULT_PASSPHRASE") {
          this.failedUnlocks += 1;
          if (this.failedUnlocks >= 5) this.lockoutUntil = now + 60_000;
        }
        throw error;
      }
      try {
        const metadata: HostConnectionMetadata = {
          host: vault.host,
          port: vault.port,
          username: vault.username,
          fingerprint: vault.fingerprint,
        };
        const keyPath = await this.writeRuntimeKey(key);
        const knownHostsPath = await this.options.mount.verifyHost(metadata, this.options.runtimeDirectory);
        const mountHandle = await this.options.mount.mount(metadata, keyPath, knownHostsPath, this.options.mountPath);
        const token = this.dependencies.tokenFactory();
        const expiresAt = now + 900_000;
        this.mountHandle = mountHandle;
        this.session = { token, expiresAt };
        this.connection = metadata;
        this.failedUnlocks = 0;
        this.lockoutUntil = 0;
        return { token, expiresAt: new Date(expiresAt).toISOString() };
      } catch (error) {
        await this.runtimeFs.rm(this.options.runtimeDirectory, { recursive: true, force: true });
        throw error;
      } finally {
        key.fill(0);
      }
    });
  }

  authorize(token: string | undefined): HostVaultSession {
    if (!this.session || !token || token !== this.session.token || !this.mountHandle?.isAlive()) {
      if (this.session) void this.serialized(() => this.lockInternal());
      throw new HostVaultError("VAULT_SESSION_INVALID", "Vault session is invalid");
    }
    this.session.expiresAt = this.dependencies.now() + 900_000;
    return { ...this.session };
  }

  touch(token: string | undefined): void {
    this.authorize(token);
  }

  async status(token?: string): Promise<HostVaultStatus> {
    const vault = await this.options.store.read();
    const validSession = Boolean(this.session && token && token === this.session.token && this.mountHandle?.isAlive());
    const connection = this.connection ?? (vault ? {
      host: vault.host,
      port: vault.port,
      username: vault.username,
      fingerprint: vault.fingerprint,
    } : null);
    return {
      configured: vault !== null,
      state: vault === null ? "unconfigured" : validSession ? "unlocked" : "locked",
      connection,
      expiresAt: validSession && this.session ? new Date(this.session.expiresAt).toISOString() : null,
      lockoutRemainingMs: Math.max(0, this.lockoutUntil - this.dependencies.now()),
      mountHealthy: validSession,
    };
  }

  async lock(token?: string): Promise<void> {
    return this.serialized(async () => {
      if (token !== undefined && (!this.session || token !== this.session.token)) {
        throw new HostVaultError("VAULT_SESSION_INVALID", "Vault session is invalid");
      }
      await this.lockInternal();
    });
  }

  onLock(listener: () => void | Promise<void>): () => void {
    this.lockListeners.add(listener);
    return () => this.lockListeners.delete(listener);
  }

  async reset(confirmation: string): Promise<void> {
    return this.serialized(async () => {
      if (confirmation !== "RESET HOST VAULT") {
        throw new HostVaultError("INVALID_VAULT_SETUP", "Type RESET HOST VAULT to reset the vault");
      }
      await this.lockInternal();
      await this.options.store.remove();
      this.connection = null;
      this.failedUnlocks = 0;
      this.lockoutUntil = 0;
    });
  }

  async dispose(): Promise<void> {
    this.dependencies.clearInterval(this.timer);
    await this.serialized(() => this.lockInternal());
  }

  private async writeRuntimeKey(key: Buffer): Promise<string> {
    await this.runtimeFs.rm(this.options.runtimeDirectory, { recursive: true, force: true });
    await this.runtimeFs.mkdir(this.options.runtimeDirectory, { recursive: true });
    const keyPath = path.posix.join(this.options.runtimeDirectory.replaceAll("\\", "/"), "id_host");
    await this.runtimeFs.writeFile(keyPath, key, { mode: 0o600 });
    return keyPath;
  }

  private async lockInternal(): Promise<void> {
    const hadSession = this.session !== null || this.mountHandle !== null;
    const mountHandle = this.mountHandle;
    this.session = null;
    this.mountHandle = null;
    if (hadSession) {
      for (const listener of this.lockListeners) await listener();
    }
    await mountHandle?.unmount();
    await this.runtimeFs.rm(this.options.runtimeDirectory, { recursive: true, force: true });
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}
