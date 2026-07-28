import { describe, expect, it } from "vitest";
import { normalizeFileType, projectStorageResult } from "../src/storageProjection.js";
import type { StorageScanTree, StorageTreeNode } from "../src/storageTypes.js";

function file(name: string, size: number): StorageTreeNode {
  return {
    name,
    relativePath: name,
    kind: "file",
    size,
    fileCount: 1,
    directoryCount: 0,
    extension: "",
    children: [],
  };
}

function tree(children: StorageTreeNode[]): StorageScanTree {
  const total = children.reduce((sum, child) => sum + child.size, 0);
  return {
    rootId: "share",
    root: {
      name: "Share",
      relativePath: "",
      kind: "directory",
      size: total,
      fileCount: children.reduce((sum, child) => sum + child.fileCount, 0),
      directoryCount: 0,
      extension: "",
      children,
    },
    progress: { files: children.length, directories: 1, bytes: total, currentPath: "", elapsedMs: 10 },
    warnings: [],
    stopReason: null,
    completedAt: "2026-07-28T10:00:00.000Z",
  };
}

describe("storage result projection", () => {
  it("normalizes extensions into stable file type groups", () => {
    expect(normalizeFileType("MODEL.GGUF")).toEqual({ extension: ".gguf", typeGroup: "model" });
    expect(normalizeFileType("archive.tar.gz")).toEqual({ extension: ".gz", typeGroup: "archive" });
    expect(normalizeFileType("README")).toEqual({ extension: "", typeGroup: "other" });
  });

  it("groups tiny same-extension files while preserving totals", () => {
    const source = tree([
      file("model.gguf", 1_000),
      file("movie.mp4", 800),
      file("cover.jpg", 600),
      file("README", 500),
      ...Array.from({ length: 20 }, (_, index) => file(`tiny-${index}.json`, 1)),
    ]);

    const result = projectStorageResult(source, "", 6, "job-1");

    expect(result.root.size).toBe(source.root.size);
    expect(result.visibleNodeCount).toBeLessThanOrEqual(6);
    expect(result.root.children).toContainEqual(expect.objectContaining({
      kind: "aggregate",
      extension: ".json",
      openable: false,
      aggregateCount: 20,
      size: 20,
    }));
    expect(result.root.children.reduce((sum, child) => sum + child.size, 0)).toBe(source.root.size);
  });

  it("marks unreadable entries as incomplete", () => {
    const source = tree([file("one.txt", 1)]);
    source.warnings = [{ code: "PERMISSION_DENIED", path: "private" }];

    const result = projectStorageResult(source, "", 50, "job-1");

    expect(result.incomplete).toBe(true);
    expect(result.incompleteReason).toBe("unreadable_entries");
  });

  it("rejects unavailable and escaping result paths", () => {
    const source = tree([file("one.txt", 1)]);
    expect(() => projectStorageResult(source, "../outside", 50, "job-1")).toThrowError("Result path is unavailable");
    expect(() => projectStorageResult(source, "missing", 50, "job-1")).toThrowError("Result path is unavailable");
  });
});
