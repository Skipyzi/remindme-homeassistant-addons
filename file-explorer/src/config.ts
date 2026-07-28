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
  };
}
