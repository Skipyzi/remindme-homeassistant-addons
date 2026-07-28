import type { Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { StorageScanFatalError } from "./errors.js";
import type { AuthorizedPath, StorageScanLimits } from "./types.js";
import type {
  ScanStopReason,
  StorageScanProgress,
  StorageScanTree,
  StorageTreeNode,
  StorageWarning,
} from "./storageTypes.js";

export interface StorageDirent {
  name: string;
}

export interface StorageFs {
  lstat(targetPath: string): Promise<Stats>;
  readdir(targetPath: string): Promise<StorageDirent[]>;
}

const nodeStorageFs: StorageFs = {
  lstat: (targetPath) => lstat(targetPath),
  async readdir(targetPath) {
    return (await readdir(targetPath, { withFileTypes: true })).map(({ name }) => ({ name }));
  },
};

function relativeDisplayPath(rootPath: string, childPath: string): string {
  return path.relative(rootPath, childPath).split(path.sep).join("/");
}

function addWarning(warnings: StorageWarning[], warning: StorageWarning): void {
  if (warnings.length < 100) warnings.push(warning);
}

function recoverableWarning(error: unknown, relativePath: string): StorageWarning | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ESTALE") return { code: "ENTRY_DISAPPEARED", path: relativePath };
  if (code === "EACCES" || code === "EPERM") return { code: "PERMISSION_DENIED", path: relativePath };
  if (code === "ENOTCONN") throw new StorageScanFatalError("HOST_CONNECTION_LOST");
  return null;
}

function finalizeDirectory(node: StorageTreeNode): void {
  if (node.kind === "file") return;
  node.size = 0;
  node.fileCount = 0;
  node.directoryCount = 0;
  for (const child of node.children) {
    finalizeDirectory(child);
    node.size += child.size;
    if (child.kind === "file") {
      node.fileCount += 1;
    } else {
      node.fileCount += child.fileCount;
      node.directoryCount += child.directoryCount + 1;
    }
  }
}

export class StorageScanner {
  constructor(private readonly fs: StorageFs = nodeStorageFs) {}

  async scan(
    target: AuthorizedPath,
    limits: StorageScanLimits,
    signal: AbortSignal,
    onProgress: (progress: StorageScanProgress) => void = () => undefined,
  ): Promise<StorageScanTree> {
    const startedAt = Date.now();
    const warnings: StorageWarning[] = [];
    const root: StorageTreeNode = {
      name: target.root.label,
      relativePath: "",
      kind: "directory",
      size: 0,
      fileCount: 0,
      directoryCount: 0,
      extension: "",
      children: [],
    };
    const progress: StorageScanProgress = {
      files: 0,
      directories: 1,
      bytes: 0,
      currentPath: "",
      elapsedMs: 0,
    };
    const stack = [{ absolutePath: target.absolutePath, node: root }];
    let entriesVisited = 0;
    let stopReason: ScanStopReason = null;

    const stopped = (): ScanStopReason => {
      if (signal.aborted) return "cancelled";
      if (Date.now() - startedAt >= limits.timeoutMs) return "timeout";
      if (entriesVisited >= limits.maxEntries) return "entry_limit";
      return null;
    };

    while (stack.length > 0 && stopReason === null) {
      stopReason = stopped();
      if (stopReason !== null) break;
      const current = stack.pop() as { absolutePath: string; node: StorageTreeNode };
      progress.currentPath = current.node.relativePath;
      let entries: StorageDirent[];
      try {
        entries = await this.fs.readdir(current.absolutePath);
      } catch (error) {
        const warning = recoverableWarning(error, current.node.relativePath);
        if (warning === null) throw error;
        addWarning(warnings, warning);
        continue;
      }

      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        stopReason = stopped();
        if (stopReason !== null) break;
        entriesVisited += 1;
        const childAbsolute = path.join(current.absolutePath, entry.name);
        const relativePath = relativeDisplayPath(target.absolutePath, childAbsolute);
        let stats: Stats;
        try {
          stats = await this.fs.lstat(childAbsolute);
        } catch (error) {
          const warning = recoverableWarning(error, relativePath);
          if (warning === null) throw error;
          addWarning(warnings, warning);
          continue;
        }

        if (stats.isSymbolicLink()) {
          addWarning(warnings, { code: "SYMLINK_SKIPPED", path: relativePath });
        } else if (stats.isDirectory()) {
          const child: StorageTreeNode = {
            name: entry.name,
            relativePath,
            kind: "directory",
            size: 0,
            fileCount: 0,
            directoryCount: 0,
            extension: "",
            children: [],
          };
          current.node.children.push(child);
          progress.directories += 1;
          stack.push({ absolutePath: childAbsolute, node: child });
        } else if (stats.isFile()) {
          const extension = path.extname(entry.name).toLowerCase();
          current.node.children.push({
            name: entry.name,
            relativePath,
            kind: "file",
            size: stats.size,
            fileCount: 1,
            directoryCount: 0,
            extension,
            children: [],
          });
          progress.files += 1;
          progress.bytes += stats.size;
        } else {
          addWarning(warnings, { code: "UNSUPPORTED_ENTRY", path: relativePath });
        }

        progress.elapsedMs = Date.now() - startedAt;
        if (entriesVisited % 100 === 0) onProgress({ ...progress });
      }
    }

    finalizeDirectory(root);
    progress.bytes = root.size;
    progress.elapsedMs = Date.now() - startedAt;
    onProgress({ ...progress });
    return {
      rootId: target.root.id,
      root,
      progress,
      warnings,
      stopReason,
      completedAt: new Date().toISOString(),
    };
  }
}
