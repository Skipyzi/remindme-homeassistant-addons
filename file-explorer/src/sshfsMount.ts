import { execFile as nodeExecFile, spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HostConnectionMetadata } from "./hostVaultTypes.js";
import { HostVaultError } from "./hostVaultTypes.js";

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface MountChild {
  exitCode: number | null;
  stderr: NodeJS.EventEmitter;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface SshfsDependencies {
  execFile(file: string, args: string[], options: { timeout: number; maxBuffer: number }): Promise<CommandResult>;
  spawn(file: string, args: string[], options: { stdio: ["ignore", "ignore", "pipe"] }): MountChild;
  access(targetPath: string): Promise<void>;
  mkdir(targetPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(targetPath: string, data: string, options: { mode: number }): Promise<void>;
  readFile(targetPath: string, encoding: "utf8"): Promise<string>;
  sleep(milliseconds: number): Promise<void>;
}

export interface SshfsMountHandle {
  isAlive(): boolean;
  unmount(): Promise<void>;
}

function execFile(file: string, args: string[], options: { timeout: number; maxBuffer: number }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

const nodeDependencies: SshfsDependencies = {
  execFile,
  spawn: (file, args, options) => nodeSpawn(file, args, options) as unknown as ChildProcessWithoutNullStreams,
  access,
  mkdir,
  writeFile,
  readFile,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function fingerprintFrom(output: string): string | null {
  return output.match(/(?:^|\s)(SHA256:[A-Za-z0-9+/]+={0,2})(?:\s|$)/)?.[1] ?? null;
}

export class SshfsMountAdapter {
  constructor(private readonly dependencies: SshfsDependencies = nodeDependencies) {}

  async verifyHost(metadata: HostConnectionMetadata, runtimeDirectory: string): Promise<string> {
    await this.dependencies.mkdir(runtimeDirectory, { recursive: true });
    const knownHostsPath = path.join(runtimeDirectory, "known_hosts");
    try {
      const scanned = await this.dependencies.execFile(
        "ssh-keyscan",
        ["-p", String(metadata.port), metadata.host],
        { timeout: 10_000, maxBuffer: 64 * 1024 },
      );
      if (!scanned.stdout.trim()) throw new HostVaultError("SSH_UNAVAILABLE", "Host SSH service is unavailable");
      await this.dependencies.writeFile(knownHostsPath, scanned.stdout, { mode: 0o600 });
      const inspected = await this.dependencies.execFile(
        "ssh-keygen",
        ["-lf", knownHostsPath, "-E", "sha256"],
        { timeout: 5_000, maxBuffer: 64 * 1024 },
      );
      const observed = fingerprintFrom(inspected.stdout);
      if (!observed || !safeEqual(observed, metadata.fingerprint)) {
        throw new HostVaultError("HOST_KEY_MISMATCH", "Host key fingerprint does not match");
      }
      return knownHostsPath;
    } catch (error) {
      if (error instanceof HostVaultError) throw error;
      throw new HostVaultError("SSH_UNAVAILABLE", "Host SSH service is unavailable");
    }
  }

  async mount(
    metadata: HostConnectionMetadata,
    keyPath: string,
    knownHostsPath: string,
    mountPath: string,
  ): Promise<SshfsMountHandle> {
    try {
      await this.dependencies.access("/dev/fuse");
    } catch {
      throw new HostVaultError("FUSE_UNAVAILABLE", "FUSE device is unavailable");
    }
    await this.dependencies.mkdir(mountPath, { recursive: true });
    const args = [
      `${metadata.username}@${metadata.host}:/`,
      mountPath,
      "-p", String(metadata.port),
      "-o", "ro",
      "-o", "reconnect",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "StrictHostKeyChecking=yes",
      "-o", `IdentityFile=${keyPath}`,
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
    ];
    let child: MountChild;
    try {
      child = this.dependencies.spawn("sshfs", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      throw new HostVaultError("HOST_MOUNT_FAILED", "Host filesystem mount failed");
    }
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: unknown) => {
      if (stderrBytes >= 8 * 1024) return;
      stderrBytes += Buffer.byteLength(String(chunk));
    });
    child.on("error", () => undefined);

    try {
      let mounted = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (child.exitCode !== null) break;
        const mountInfo = await this.dependencies.readFile("/proc/self/mountinfo", "utf8");
        if (mountInfo.split("\n").some((line) => line.includes(` ${mountPath} `) && line.includes("fuse.sshfs"))) {
          mounted = true;
          break;
        }
        await this.dependencies.sleep(500);
      }
      if (!mounted) throw new HostVaultError("HOST_MOUNT_FAILED", "Host filesystem mount failed");
    } catch (error) {
      child.kill("SIGTERM");
      if (error instanceof HostVaultError) throw error;
      throw new HostVaultError("HOST_MOUNT_FAILED", "Host filesystem mount failed");
    }

    let unmounted = false;
    return {
      isAlive: () => !unmounted && child.exitCode === null,
      unmount: async () => {
        if (unmounted) return;
        unmounted = true;
        try {
          await this.dependencies.execFile("fusermount3", ["-u", mountPath], { timeout: 5_000, maxBuffer: 8 * 1024 });
        } catch {
          try {
            await this.dependencies.execFile("fusermount3", ["-u", "-z", mountPath], { timeout: 5_000, maxBuffer: 8 * 1024 });
          } catch {
            // The process is still terminated below; stale mount cleanup is best effort.
          }
        } finally {
          child.kill("SIGTERM");
        }
      },
    };
  }
}
