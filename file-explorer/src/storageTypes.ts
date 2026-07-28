export type ScanStopReason = "entry_limit" | "timeout" | "cancelled" | null;
export type StorageWarningCode = "ENTRY_DISAPPEARED" | "PERMISSION_DENIED" | "SYMLINK_SKIPPED" | "UNSUPPORTED_ENTRY";

export interface StorageWarning {
  code: StorageWarningCode;
  path: string;
}

export interface StorageScanProgress {
  files: number;
  directories: number;
  bytes: number;
  currentPath: string;
  elapsedMs: number;
}

export interface StorageTreeNode {
  name: string;
  relativePath: string;
  kind: "file" | "directory";
  size: number;
  fileCount: number;
  directoryCount: number;
  extension: string;
  children: StorageTreeNode[];
  excluded?: boolean;
}

export interface StorageScanTree {
  rootId: string;
  root: StorageTreeNode;
  progress: StorageScanProgress;
  warnings: StorageWarning[];
  stopReason: ScanStopReason;
  completedAt: string;
  excludedPaths?: string[];
}

export interface StorageMapNode {
  id: string;
  name: string;
  relativePath: string | null;
  kind: "file" | "directory" | "aggregate";
  size: number;
  fileCount: number;
  directoryCount: number;
  extension: string;
  typeGroup: string;
  openable: boolean;
  aggregateCount: number;
  children: StorageMapNode[];
  excluded?: boolean;
}

export interface StorageMapResult {
  rootId: string;
  requestedPath: string;
  root: StorageMapNode;
  visibleNodeCount: number;
  totalFiles: number;
  totalDirectories: number;
  totalBytes: number;
  completedAt: string;
  incomplete: boolean;
  incompleteReason: ScanStopReason | "unreadable_entries";
  warnings: StorageWarning[];
  excludedPaths?: string[];
}

export type StorageJobStatus = "running" | "complete" | "partial" | "cancelled" | "failed";

export interface StorageJobSnapshot {
  id: string;
  root: string;
  scanPath: string;
  status: StorageJobStatus;
  progress: StorageScanProgress;
  warnings: StorageWarning[];
  truncated: boolean;
  truncationReason: ScanStopReason;
  cached: boolean;
  completedAt: string | null;
  error: { code: string; message: string } | null;
  resultAvailable: boolean;
}
