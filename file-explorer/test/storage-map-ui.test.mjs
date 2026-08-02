// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { createStorageMap } from "../public/storage-map.js";

const completeJob = {
  id: "job-1",
  root: "share",
  status: "complete",
  progress: { files: 3, directories: 2, bytes: 10, currentPath: "", elapsedMs: 20 },
  warnings: [],
  truncated: false,
  truncationReason: null,
  cached: false,
  completedAt: "2026-07-28T10:00:00.000Z",
  error: null,
  resultAvailable: true,
};

const result = {
  rootId: "share",
  requestedPath: "",
  root: {
    id: "root",
    name: "Share",
    relativePath: "",
    kind: "directory",
    size: 10,
    fileCount: 3,
    directoryCount: 1,
    extension: "",
    typeGroup: "directory",
    openable: true,
    aggregateCount: 0,
    children: [
      { id: "dir", name: "media", relativePath: "media", kind: "directory", size: 6, fileCount: 1, directoryCount: 0, extension: "", typeGroup: "directory", openable: true, aggregateCount: 0, children: [] },
      { id: "file", name: "notes.txt", relativePath: "notes.txt", kind: "file", size: 3, fileCount: 1, directoryCount: 0, extension: ".txt", typeGroup: "text", openable: true, aggregateCount: 0, children: [] },
      { id: "aggregate", name: "Other .json files", relativePath: null, kind: "aggregate", size: 1, fileCount: 1, directoryCount: 0, extension: ".json", typeGroup: "text", openable: false, aggregateCount: 1, children: [] },
    ],
  },
  visibleNodeCount: 4,
  totalFiles: 3,
  totalDirectories: 1,
  totalBytes: 10,
  completedAt: "2026-07-28T10:00:00.000Z",
  incomplete: false,
  incompleteReason: null,
  warnings: [],
};

beforeEach(async () => {
  document.documentElement.innerHTML = await readFile(path.resolve("public/index.html"), "utf8");
});

function setup(overrides = {}) {
  const operations = {
    startStorageScan: vi.fn().mockResolvedValue({ job: completeJob }),
    storageScanStatus: vi.fn().mockResolvedValue({ job: completeJob }),
    storageScanResult: vi.fn().mockResolvedValue({ result }),
    cancelStorageScan: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const onOpenFile = vi.fn();
  const onClose = vi.fn();
  const controller = createStorageMap({
    operations,
    onOpenFile,
    onClose,
    formatSize: (size) => `${size} B`,
    pollDelay: 0,
    getBounds: () => ({ width: 1000, height: 600 }),
  });
  return { controller, operations, onOpenFile, onClose };
}

it("renders scan results and opens directories and real files", async () => {
  const { controller, operations, onOpenFile } = setup();
  await controller.open("share");

  expect(document.querySelector("[data-storage-map]").hidden).toBe(false);
  expect(document.querySelector("[data-storage-summary]").textContent).toContain("3 files");
  expect(document.querySelectorAll("[data-storage-node]")).toHaveLength(3);
  expect(document.querySelector("[data-storage-legend]").textContent).toContain("Text");

  document.querySelector('[data-storage-node="dir"]').click();
  await vi.waitFor(() => expect(operations.storageScanResult).toHaveBeenLastCalledWith("job-1", "media"));

  document.querySelector('[data-storage-node="file"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onOpenFile).toHaveBeenCalledWith({ name: "notes.txt", path: "notes.txt", type: "file", size: 3 });

  document.querySelector('[data-storage-node="aggregate"]').click();
  expect(onOpenFile).toHaveBeenCalledTimes(1);
  expect(document.querySelector("[data-storage-details]").textContent).toContain("Other .json files");
});

it("starts an exact subtree scan from Map this folder", async () => {
  const { controller, operations } = setup();

  await controller.open("host", "mnt/data");

  expect(operations.startStorageScan).toHaveBeenCalledWith("host", "mnt/data", false);
});

it("shows running progress and cancels without closing", async () => {
  const running = { ...completeJob, status: "running", completedAt: null, resultAvailable: false };
  const { controller, operations } = setup({
    startStorageScan: vi.fn().mockResolvedValue({ job: running }),
    storageScanStatus: vi.fn().mockResolvedValue({ job: running }),
  });
  await controller.open("share");

  expect(document.querySelector("[data-storage-status]").textContent).toContain("Scanning");
  expect(document.querySelector("[data-storage-cancel]").hidden).toBe(false);
  document.querySelector("[data-storage-cancel]").click();
  await vi.waitFor(() => expect(operations.cancelStorageScan).toHaveBeenCalledWith("job-1"));
  expect(document.querySelector("[data-storage-map]").hidden).toBe(false);
  controller.close();
});

it("labels incomplete results and closes without cancelling", async () => {
  const partial = { ...completeJob, status: "partial", truncated: true, truncationReason: "entry_limit" };
  const partialResult = { ...result, incomplete: true, incompleteReason: "unreadable_entries" };
  const { controller, operations, onClose } = setup({
    startStorageScan: vi.fn().mockResolvedValue({ job: partial }),
    storageScanResult: vi.fn().mockResolvedValue({ result: partialResult }),
  });
  await controller.open("share");

  expect(document.querySelector("[data-storage-status]").textContent).toContain("unreadable entries skipped");
  controller.close();
  expect(operations.cancelStorageScan).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.querySelector("[data-storage-map]").hidden).toBe(true);
});
