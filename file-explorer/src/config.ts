import { readFile } from "node:fs/promises";
import type { ExplorerConfig, RootDefinition, RootId } from "./types.js";

interface RawOptions {
  enable_config?: boolean;
  enable_share?: boolean;
  enable_media?: boolean;
  text_edit_max_bytes?: number;
  search_file_max_bytes?: number;
  upload_max_bytes?: number;
  search_max_results?: number;
  search_timeout_seconds?: number;
  retention_days?: number;
  storage_scan_max_entries?: number;
  storage_scan_timeout_seconds?: number;
  storage_scan_cache_seconds?: number;
  storage_map_max_nodes?: number;
  host_scan_max_entries?: number;
  host_scan_timeout_seconds?: number;
  host_scan_cache_seconds?: number;
  host_map_max_nodes?: number;
}

export interface RootPaths {
  config: string;
  share: string;
  media: string;
}

const defaultRootPaths: RootPaths = {
  config: "/config",
  share: "/share",
  media: "/media",
};

function clamp(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = Number.isFinite(value) ? Math.trunc(value as number) : fallback;
  return Math.min(maximum, Math.max(minimum, candidate));
}

export async function loadConfig(
  optionsPath: string,
  dataDir: string,
  rootPaths: RootPaths = defaultRootPaths,
): Promise<ExplorerConfig> {
  let raw: RawOptions;
  try {
    raw = JSON.parse(await readFile(optionsPath, "utf8")) as RawOptions;
  } catch (error) {
    throw new Error("Add-on options are not valid JSON", { cause: error });
  }
  const roots: RootDefinition[] = ([
    ["config", "Config", rootPaths.config, raw.enable_config ?? true],
    ["share", "Share", rootPaths.share, raw.enable_share ?? true],
    ["media", "Media", rootPaths.media, raw.enable_media ?? true],
  ] satisfies Array<[RootId, string, string, boolean]>).map(([id, label, absolutePath, enabled]) => ({
    id,
    label,
    absolutePath,
    enabled,
    readOnly: false,
  }));

  return {
    roots,
    dataDir,
    textEditMaxBytes: raw.text_edit_max_bytes ?? 1_048_576,
    searchFileMaxBytes: raw.search_file_max_bytes ?? 2_097_152,
    uploadMaxBytes: raw.upload_max_bytes ?? 104_857_600,
    searchMaxResults: raw.search_max_results ?? 500,
    searchTimeoutMs: (raw.search_timeout_seconds ?? 15) * 1_000,
    retentionDays: raw.retention_days ?? 30,
    storageScan: {
      maxEntries: clamp(raw.storage_scan_max_entries, 200_000, 1_000, 1_000_000),
      timeoutMs: clamp(raw.storage_scan_timeout_seconds, 120, 5, 600) * 1_000,
      cacheTtlMs: clamp(raw.storage_scan_cache_seconds, 60, 5, 3_600) * 1_000,
      maxResultNodes: clamp(raw.storage_map_max_nodes, 5_000, 100, 10_000),
    },
    hostStorageScan: {
      maxEntries: clamp(raw.host_scan_max_entries, 1_000_000, 1_000, 1_000_000),
      timeoutMs: clamp(raw.host_scan_timeout_seconds, 600, 5, 600) * 1_000,
      cacheTtlMs: clamp(raw.host_scan_cache_seconds, 300, 5, 3_600) * 1_000,
      maxResultNodes: clamp(raw.host_map_max_nodes, 10_000, 100, 10_000),
    },
  };
}
