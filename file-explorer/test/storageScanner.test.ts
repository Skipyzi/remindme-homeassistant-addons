import os from "node:os";
import path from "node:path";
import type { Stats } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { StorageScanner, type StorageFs } from "../src/storageScanner.js";
import type { AuthorizedPath, StorageScanLimits } from "../src/types.js";

const created: string[] = [];
const limits: StorageScanLimits = {
  maxEntries: 200_000,
  timeoutMs: 120_000,
  cacheTtlMs: 60_000,
  maxResultNodes: 5_000,
};

afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

async function target(): Promise<AuthorizedPath> {
  const base = await mkdtemp(path.join(os.tmpdir(), "storage-scanner-"));
  created.push(base);
  return {
    root: { id: "share", label: "Share", absolutePath: base, enabled: true, readOnly: false },
    relativePath: "",
    absolutePath: base,
  };
}

function fakeStats(kind: "file" | "directory" | "symlink", size = 0): Stats {
  return {
    size,
    isFile: () => kind === "file",
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  } as Stats;
}

describe("StorageScanner", () => {
  it("aggregates nested logical file sizes without leaking absolute paths", async () => {
    const scanTarget = await target();
    await mkdir(path.join(scanTarget.absolutePath, "nested"));
    await writeFile(path.join(scanTarget.absolutePath, "five.txt"), "12345");
    await writeFile(path.join(scanTarget.absolutePath, "nested", "six.bin"), "123456");

    const result = await new StorageScanner().scan(scanTarget, limits, new AbortController().signal);

    expect(result.root.size).toBe(11);
    expect(result.root.fileCount).toBe(2);
    expect(result.root.directoryCount).toBe(1);
    expect(result.root.children.find((node) => node.name === "nested")?.size).toBe(6);
    expect(result.stopReason).toBeNull();
    expect(JSON.stringify(result)).not.toContain(scanTarget.absolutePath);
  });

  it("reports symlinks without traversing them", async () => {
    const scanTarget = await target();
    const fs: StorageFs = {
      async readdir() { return [{ name: "escape" }]; },
      async lstat() { return fakeStats("symlink"); },
    };

    const result = await new StorageScanner(fs).scan(scanTarget, limits, new AbortController().signal);

    expect(result.root.children).toHaveLength(0);
    expect(result.warnings).toContainEqual({ code: "SYMLINK_SKIPPED", path: "escape" });
  });

  it("returns an honest partial tree at the entry limit", async () => {
    const scanTarget = await target();
    await writeFile(path.join(scanTarget.absolutePath, "one.txt"), "1");
    await writeFile(path.join(scanTarget.absolutePath, "two.txt"), "22");

    const result = await new StorageScanner().scan(
      scanTarget,
      { ...limits, maxEntries: 1 },
      new AbortController().signal,
    );

    expect(result.stopReason).toBe("entry_limit");
    expect(result.progress.files).toBe(1);
  });

  it.each(["ENOENT", "ESTALE"])("continues when an entry disappears with %s", async (code) => {
    const scanTarget = await target();
    const fs: StorageFs = {
      async readdir() { return [{ name: "gone" }, { name: "kept.txt" }]; },
      async lstat(targetPath) {
        if (targetPath.endsWith("gone")) throw Object.assign(new Error("gone"), { code });
        return fakeStats("file", 7);
      },
    };

    const result = await new StorageScanner(fs).scan(scanTarget, limits, new AbortController().signal);

    expect(result.root.size).toBe(7);
    expect(result.warnings).toContainEqual({ code: "ENTRY_DISAPPEARED", path: "gone" });
    expect(result.stopReason).toBeNull();
  });

  it("raises a safe typed error when SSHFS disconnects", async () => {
    const scanTarget = await target();
    const fs: StorageFs = {
      async readdir() { throw Object.assign(new Error("transport details"), { code: "ENOTCONN" }); },
      async lstat() { return fakeStats("file", 1); },
    };

    await expect(new StorageScanner(fs).scan(scanTarget, limits, new AbortController().signal))
      .rejects.toMatchObject({ code: "HOST_CONNECTION_LOST", message: "Host connection lost" });
  });

  it("honors cancellation before touching the filesystem", async () => {
    const scanTarget = await target();
    const controller = new AbortController();
    controller.abort();

    const result = await new StorageScanner().scan(scanTarget, limits, controller.signal);

    expect(result.stopReason).toBe("cancelled");
    expect(result.progress.files).toBe(0);
  });
});
