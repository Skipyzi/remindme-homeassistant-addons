import { describe, expect, it, vi } from "vitest";
import { StorageScanService } from "../src/storageScanService.js";
import type { ScanStopReason, StorageScanTree } from "../src/storageTypes.js";
import type { AuthorizedPath, StorageScanLimits } from "../src/types.js";

const limits: StorageScanLimits = {
  maxEntries: 200_000,
  timeoutMs: 120_000,
  cacheTtlMs: 60_000,
  maxResultNodes: 5_000,
};

function target(rootId = "config"): AuthorizedPath {
  return {
    root: { id: rootId as "config", label: "Config", absolutePath: `/roots/${rootId}`, enabled: true, readOnly: false },
    relativePath: "",
    absolutePath: `/roots/${rootId}`,
  };
}

function tree(rootId = "config", stopReason: ScanStopReason = null): StorageScanTree {
  return {
    rootId,
    root: {
      name: "Config",
      relativePath: "",
      kind: "directory",
      size: 5,
      fileCount: 1,
      directoryCount: 0,
      extension: "",
      children: [{
        name: "five.txt",
        relativePath: "five.txt",
        kind: "file",
        size: 5,
        fileCount: 1,
        directoryCount: 0,
        extension: ".txt",
        children: [],
      }],
    },
    progress: { files: 1, directories: 1, bytes: 5, currentPath: "", elapsedMs: 10 },
    warnings: [],
    stopReason,
    completedAt: "2026-07-28T10:00:00.000Z",
  };
}

function policy() {
  return {
    authorize: vi.fn(async (rootId: string, relativePath: string) => ({
      ...target(rootId),
      relativePath,
      absolutePath: `/roots/${rootId}/${relativePath}`,
    })),
  };
}

function ids() {
  let value = 0;
  return () => `job-${++value}`;
}

describe("StorageScanService", () => {
  it("deduplicates active scans and reuses a fresh completed cache", async () => {
    let finish: ((value: StorageScanTree) => void) | undefined;
    const scanner = { scan: vi.fn(() => new Promise<StorageScanTree>((resolve) => { finish = resolve; })) };
    const service = new StorageScanService(policy(), scanner, limits, { idFactory: ids() });

    const first = await service.start("config", false);
    const second = await service.start("config", false);
    expect(second.id).toBe(first.id);
    expect(scanner.scan).toHaveBeenCalledTimes(1);

    finish?.(tree());
    await vi.waitFor(() => expect(service.snapshot(first.id).status).toBe("complete"));
    const cached = await service.start("config", false);
    expect(cached.id).toBe(first.id);
    expect(cached.cached).toBe(true);
    service.dispose();
  });

  it("expires cached results and starts a new job", async () => {
    let now = 1_000;
    const scanner = { scan: vi.fn(async () => tree()) };
    const service = new StorageScanService(policy(), scanner, limits, { now: () => now, idFactory: ids() });

    const first = await service.start("config", false);
    await vi.waitFor(() => expect(service.snapshot(first.id).status).toBe("complete"));
    now += limits.cacheTtlMs + 1;
    const expired = await service.start("config", false);
    expect(expired.id).not.toBe(first.id);
    expect(scanner.scan).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it("invalidates completed scans and refresh aborts older work", async () => {
    const scanner = { scan: vi.fn(async () => tree()) };
    const service = new StorageScanService(policy(), scanner, limits, { idFactory: ids() });
    const first = await service.start("config", false);
    await vi.waitFor(() => expect(service.snapshot(first.id).status).toBe("complete"));

    service.invalidate("config");
    const next = await service.start("config", false);
    expect(next.id).not.toBe(first.id);

    const refreshed = await service.start("config", true);
    expect(refreshed.id).not.toBe(next.id);
    service.dispose();
  });

  it("never lets an invalidated scan replace a refreshed cache", async () => {
    const finishes: Array<(value: StorageScanTree) => void> = [];
    const scanner = {
      scan: vi.fn(() => new Promise<StorageScanTree>((resolve) => finishes.push(resolve))),
    };
    const service = new StorageScanService(policy(), scanner, limits, { idFactory: ids() });
    const stale = await service.start("config", false);
    const refreshed = await service.start("config", true);

    finishes[1](tree());
    await vi.waitFor(() => expect(service.snapshot(refreshed.id).status).toBe("complete"));
    finishes[0](tree());
    await vi.waitFor(() => expect(service.snapshot(stale.id).status).toBe("complete"));

    const cached = await service.start("config", false);
    expect(cached.id).toBe(refreshed.id);
    service.dispose();
  });

  it("retains a safe partial result after cancellation", async () => {
    const scanner = {
      scan: vi.fn(async (_target, _limits, signal: AbortSignal) => new Promise<StorageScanTree>((resolve) => {
        signal.addEventListener("abort", () => resolve(tree("config", "cancelled")), { once: true });
      })),
    };
    const service = new StorageScanService(policy(), scanner, limits, { idFactory: ids() });
    const started = await service.start("config", false);

    service.cancel(started.id);
    await vi.waitFor(() => expect(service.snapshot(started.id).status).toBe("cancelled"));
    expect(service.snapshot(started.id).resultAvailable).toBe(true);
    await expect(service.result(started.id, "")).resolves.toMatchObject({ totalBytes: 5 });
    service.dispose();
  });
});
