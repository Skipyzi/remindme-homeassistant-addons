export type RootId = "config" | "share" | "media" | "host";
export type PathIntent = "read" | "write" | "create";

export interface RootDefinition {
  id: RootId;
  label: string;
  absolutePath: string;
  enabled: boolean;
  readOnly: boolean;
}

export interface StorageScanLimits {
  maxEntries: number;
  timeoutMs: number;
  cacheTtlMs: number;
  maxResultNodes: number;
}

export interface ExplorerConfig {
  roots: RootDefinition[];
  dataDir: string;
  textEditMaxBytes: number;
  searchFileMaxBytes: number;
  uploadMaxBytes: number;
  searchMaxResults: number;
  searchTimeoutMs: number;
  retentionDays: number;
  storageScan: StorageScanLimits;
}

export interface AuthorizedPath {
  root: RootDefinition;
  relativePath: string;
  absolutePath: string;
}

export interface EntryMetadata {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: string;
  signature: string;
}
