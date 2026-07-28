import { EventEmitter } from "node:events";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SshfsMountAdapter } from "../src/sshfsMount.js";

const metadata = {
  host: "172.30.32.1",
  port: 22222,
  username: "root",
  fingerprint: "SHA256:ZmFrZS1maW5nZXJwcmludA",
};

function child(exitCode: number | null = null) {
  const process = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  process.exitCode = exitCode;
  process.stderr = new EventEmitter();
  process.kill = vi.fn(() => true);
  return process;
}

function setup(overrides: Record<string, unknown> = {}) {
  const sshfsChild = child();
  const execFile = vi.fn(async (file: string) => {
    if (file === "ssh-keyscan") return { stdout: "[172.30.32.1]:22222 ssh-ed25519 AAAATEST\n", stderr: "" };
    if (file === "ssh-keygen") return { stdout: "256 SHA256:ZmFrZS1maW5nZXJwcmludA host (ED25519)\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });
  const dependencies = {
    execFile,
    spawn: vi.fn(() => sshfsChild),
    access: vi.fn(async () => undefined),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async () => "1 2 0:1 / /host rw - fuse.sshfs sshfs rw\n"),
    sleep: vi.fn(async () => undefined),
    ...overrides,
  };
  return { adapter: new SshfsMountAdapter(dependencies), dependencies, sshfsChild };
}

describe("SshfsMountAdapter", () => {
  it("pins the host key and mounts remote root with strict read-only options", async () => {
    const { adapter, dependencies } = setup();
    const knownHostsPath = await adapter.verifyHost(metadata, "/run/file-explorer-host");
    const handle = await adapter.mount(
      metadata,
      "/run/file-explorer-host/id_host",
      knownHostsPath,
      "/host",
    );

    expect(dependencies.execFile).toHaveBeenCalledWith("ssh-keyscan", ["-p", "22222", "172.30.32.1"], expect.any(Object));
    expect(dependencies.writeFile).toHaveBeenCalledWith(
      path.join("/run/file-explorer-host", "known_hosts"),
      "[172.30.32.1]:22222 ssh-ed25519 AAAATEST\n",
      { mode: 0o600 },
    );
    expect(dependencies.spawn).toHaveBeenCalledWith("sshfs", expect.arrayContaining([
      "root@172.30.32.1:/",
      "/host",
      "-o", "ro",
      "-o", "StrictHostKeyChecking=yes",
      "-o", "IdentityFile=/run/file-explorer-host/id_host",
      "-o", `UserKnownHostsFile=${knownHostsPath}`,
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
    ]), expect.objectContaining({ stdio: ["ignore", "ignore", "pipe"] }));
    expect(handle.isAlive()).toBe(true);
  });

  it("rejects a changed host fingerprint", async () => {
    const { adapter } = setup({
      execFile: vi.fn(async (file: string) => file === "ssh-keyscan"
        ? { stdout: "host ssh-ed25519 AAAATEST\n", stderr: "" }
        : { stdout: "256 SHA256:DIFFERENT host (ED25519)\n", stderr: "" }),
    });

    await expect(adapter.verifyHost(metadata, "/runtime")).rejects.toMatchObject({
      code: "HOST_KEY_MISMATCH",
      message: "Host key fingerprint does not match",
    });
  });

  it("reports missing FUSE without spawning", async () => {
    const access = vi.fn(async () => { throw Object.assign(new Error("missing path details"), { code: "ENOENT" }); });
    const { adapter, dependencies } = setup({ access });

    await expect(adapter.mount(metadata, "/runtime/key", "/runtime/known_hosts", "/host"))
      .rejects.toMatchObject({ code: "FUSE_UNAVAILABLE", message: "FUSE device is unavailable" });
    expect(dependencies.spawn).not.toHaveBeenCalled();
  });

  it("sanitizes early SSHFS failures", async () => {
    const failedChild = child(1);
    failedChild.stderr.emit("data", Buffer.from("secret command output /host"));
    const { adapter } = setup({ spawn: vi.fn(() => failedChild), readFile: vi.fn(async () => "") });

    await expect(adapter.mount(metadata, "/runtime/key", "/runtime/known_hosts", "/host"))
      .rejects.toMatchObject({ code: "HOST_MOUNT_FAILED", message: "Host filesystem mount failed" });
  });

  it("escalates a failed normal unmount and terminates SSHFS", async () => {
    const execFile = vi.fn(async (file: string, args: string[]) => {
      if (file === "fusermount3" && !args.includes("-z")) throw new Error("busy");
      return { stdout: "", stderr: "" };
    });
    const { adapter, sshfsChild } = setup({ execFile });
    const handle = await adapter.mount(metadata, "/runtime/key", "/runtime/known_hosts", "/host");

    await handle.unmount();

    expect(execFile).toHaveBeenCalledWith("fusermount3", ["-u", "/host"], expect.any(Object));
    expect(execFile).toHaveBeenCalledWith("fusermount3", ["-u", "-z", "/host"], expect.any(Object));
    expect(sshfsChild.kill).toHaveBeenCalled();
  });
});
