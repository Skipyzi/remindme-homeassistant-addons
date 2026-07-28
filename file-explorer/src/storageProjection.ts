import { createHash } from "node:crypto";
import path from "node:path";
import { DomainError } from "./errors.js";
import type {
  StorageMapNode,
  StorageMapResult,
  StorageScanTree,
  StorageTreeNode,
} from "./storageTypes.js";

const TYPE_GROUPS: Record<string, string> = {
  ".gguf": "model",
  ".bin": "model",
  ".zip": "archive",
  ".gz": "archive",
  ".tar": "archive",
  ".7z": "archive",
  ".mp4": "video",
  ".mkv": "video",
  ".webm": "video",
  ".mp3": "audio",
  ".flac": "audio",
  ".wav": "audio",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".yaml": "text",
  ".yml": "text",
  ".json": "text",
  ".txt": "text",
  ".md": "text",
  ".js": "text",
  ".ts": "text",
};

export function normalizeFileType(name: string): { extension: string; typeGroup: string } {
  const extension = path.extname(name).toLowerCase();
  return { extension, typeGroup: TYPE_GROUPS[extension] ?? "other" };
}

function stableId(namespace: string, kind: string, relativePath: string, extension: string): string {
  return createHash("sha256")
    .update(`${namespace}\0${kind}\0${relativePath}\0${extension}`)
    .digest("hex")
    .slice(0, 20);
}

function sourceAt(root: StorageTreeNode, rawPath: string): StorageTreeNode {
  if (rawPath.startsWith("/") || /^[A-Za-z]:/.test(rawPath)) {
    throw new DomainError("RESULT_PATH_UNAVAILABLE", 404, "Result path is unavailable");
  }
  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new DomainError("RESULT_PATH_UNAVAILABLE", 404, "Result path is unavailable");
  }
  const relativePath = normalized === "." ? "" : normalized;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as StorageTreeNode;
    if (node.relativePath === relativePath && node.kind === "directory") return node;
    for (const child of node.children) {
      if (child.kind === "directory") stack.push(child);
    }
  }
  throw new DomainError("RESULT_PATH_UNAVAILABLE", 404, "Result path is unavailable");
}

function publicNode(source: StorageTreeNode, namespace: string): StorageMapNode {
  const type = source.kind === "file" ? normalizeFileType(source.name) : { extension: "", typeGroup: "directory" };
  return {
    id: stableId(namespace, source.kind, source.relativePath, type.extension),
    name: source.name,
    relativePath: source.relativePath,
    kind: source.kind,
    size: source.size,
    fileCount: source.fileCount,
    directoryCount: source.directoryCount,
    extension: type.extension,
    typeGroup: type.typeGroup,
    openable: !source.excluded,
    aggregateCount: 0,
    children: [],
    excluded: source.excluded,
  };
}

function aggregateFiles(files: StorageTreeNode[], extension: string, namespace: string): StorageMapNode {
  const typeGroup = normalizeFileType(`file${extension}`).typeGroup;
  const parent = path.posix.dirname(files[0]?.relativePath ?? "");
  const label = extension ? `Other ${extension} files` : "Other extensionless files";
  return {
    id: stableId(namespace, "aggregate", parent === "." ? "" : parent, extension),
    name: label,
    relativePath: null,
    kind: "aggregate",
    size: files.reduce((sum, file) => sum + file.size, 0),
    fileCount: files.reduce((sum, file) => sum + file.fileCount, 0),
    directoryCount: files.reduce((sum, file) => sum + file.directoryCount, 0),
    extension,
    typeGroup,
    openable: false,
    aggregateCount: files.reduce((sum, file) => sum + file.fileCount, 0),
    children: [],
  };
}

function compactChildren(children: StorageTreeNode[], slots: number, namespace: string): StorageMapNode[] {
  const ordered = [...children].sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
  if (ordered.length <= slots) return ordered.map((child) => publicNode(child, namespace));

  const directories = ordered.filter((child) => child.kind === "directory");
  const filesByExtension = new Map<string, StorageTreeNode[]>();
  for (const file of ordered.filter((child) => child.kind === "file")) {
    const extension = normalizeFileType(file.name).extension;
    const group = filesByExtension.get(extension) ?? [];
    group.push(file);
    filesByExtension.set(extension, group);
  }

  let candidates: StorageMapNode[] = directories.map((child) => publicNode(child, namespace));
  for (const [extension, files] of filesByExtension) {
    candidates.push(files.length === 1 ? publicNode(files[0], namespace) : aggregateFiles(files, extension, namespace));
  }
  candidates = candidates.sort((left, right) => right.size - left.size || left.name.localeCompare(right.name));
  if (candidates.length <= slots) return candidates;

  const kept = candidates.slice(0, Math.max(0, slots - 1));
  const omitted = candidates.slice(Math.max(0, slots - 1));
  kept.push({
    id: stableId(namespace, "aggregate", "omitted", ""),
    name: "Other items",
    relativePath: null,
    kind: "aggregate",
    size: omitted.reduce((sum, node) => sum + node.size, 0),
    fileCount: omitted.reduce((sum, node) => sum + node.fileCount, 0),
    directoryCount: omitted.reduce((sum, node) => sum + node.directoryCount + (node.kind === "directory" ? 1 : 0), 0),
    extension: "",
    typeGroup: "other",
    openable: false,
    aggregateCount: omitted.reduce((sum, node) => sum + node.fileCount, 0),
    children: [],
  });
  return kept;
}

function countVisible(node: StorageMapNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countVisible(child), 0);
}

export function projectStorageResult(
  tree: StorageScanTree,
  relativePath: string,
  maxNodes: number,
  idNamespace: string,
): StorageMapResult {
  const source = sourceAt(tree.root, relativePath);
  const root = publicNode(source, idNamespace);
  root.children = compactChildren(source.children, Math.max(1, maxNodes - 1), idNamespace);
  const hasUnreadableEntries = tree.warnings.some((warning) => warning.code === "PERMISSION_DENIED" || warning.code === "UNSUPPORTED_ENTRY");
  return {
    rootId: tree.rootId,
    requestedPath: source.relativePath,
    root,
    visibleNodeCount: countVisible(root),
    totalFiles: source.fileCount,
    totalDirectories: source.directoryCount,
    totalBytes: source.size,
    completedAt: tree.completedAt,
    incomplete: tree.stopReason !== null || hasUnreadableEntries,
    incompleteReason: tree.stopReason ?? (hasUnreadableEntries ? "unreadable_entries" : null),
    warnings: tree.warnings,
    excludedPaths: tree.excludedPaths ?? [],
  };
}
