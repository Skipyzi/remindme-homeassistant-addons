import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRootRegistry } from "../src/roots.js";
import type { ExplorerConfig } from "../src/types.js";

export async function createFixtureRoots() {
  const base = await mkdtemp(path.join(os.tmpdir(), "ha-file-explorer-"));
  const configRoot = path.join(base, "config");
  const shareRoot = path.join(base, "share");
  const dataDir = path.join(base, "data");
  await mkdir(path.join(configRoot, "automations"), { recursive: true });
  await mkdir(shareRoot, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(configRoot, "automations", "morning.yaml"), "alias: Morning\n");

  const config: ExplorerConfig = {
    roots: [
      { id: "config", label: "Config", absolutePath: configRoot, enabled: true, readOnly: false },
      { id: "share", label: "Share", absolutePath: shareRoot, enabled: false, readOnly: false },
    ],
    dataDir,
    textEditMaxBytes: 1_048_576,
    searchFileMaxBytes: 2_097_152,
    uploadMaxBytes: 104_857_600,
    searchMaxResults: 500,
    searchTimeoutMs: 15_000,
    retentionDays: 30,
    storageScan: {
      maxEntries: 200_000,
      timeoutMs: 120_000,
      cacheTtlMs: 60_000,
      maxResultNodes: 5_000,
    },
    hostStorageScan: {
      maxEntries: 1_000_000,
      timeoutMs: 600_000,
      cacheTtlMs: 300_000,
      maxResultNodes: 10_000,
    },
  };

  return {
    base,
    configRoot,
    shareRoot,
    dataDir,
    config,
    registry: createRootRegistry(config),
    protectedPaths: [path.join(dataDir, "trash"), path.join(dataDir, "backups")],
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}
