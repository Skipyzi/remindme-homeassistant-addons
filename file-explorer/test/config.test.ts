import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

async function load(options: object) {
  const base = await mkdtemp(path.join(os.tmpdir(), "file-explorer-config-"));
  created.push(base);
  const optionsPath = path.join(base, "options.json");
  await writeFile(optionsPath, JSON.stringify(options));
  return loadConfig(optionsPath, path.join(base, "data"), {
    config: path.join(base, "config"),
    share: path.join(base, "share"),
    media: path.join(base, "media"),
  });
}

it("uses safe storage scan defaults", async () => {
  const config = await load({});
  expect(config.storageScan).toEqual({
    maxEntries: 200_000,
    timeoutMs: 120_000,
    cacheTtlMs: 60_000,
    maxResultNodes: 5_000,
  });
  expect(config.hostStorageScan).toEqual({
    maxEntries: 1_000_000,
    timeoutMs: 600_000,
    cacheTtlMs: 300_000,
    maxResultNodes: 10_000,
  });
});

it("clamps storage scan options", async () => {
  const config = await load({
    storage_scan_max_entries: 1,
    storage_scan_timeout_seconds: 9_999,
    storage_scan_cache_seconds: 0,
    storage_map_max_nodes: 99_999,
    host_scan_max_entries: 2,
    host_scan_timeout_seconds: 1,
    host_scan_cache_seconds: 99_999,
    host_map_max_nodes: 2,
  });
  expect(config.storageScan).toEqual({
    maxEntries: 1_000,
    timeoutMs: 600_000,
    cacheTtlMs: 5_000,
    maxResultNodes: 10_000,
  });
  expect(config.hostStorageScan).toEqual({
    maxEntries: 1_000,
    timeoutMs: 5_000,
    cacheTtlMs: 3_600_000,
    maxResultNodes: 100,
  });
});
