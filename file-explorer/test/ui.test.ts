// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../public/api.js";
import { createEditorState } from "../public/editor.js";
import { createOperations } from "../public/operations.js";
import {
  breadcrumbSegments,
  createExplorerState,
  nextTreeIndex,
  parentPath,
} from "../public/tree.js";

describe("explorer client", () => {
  it("uses ingress-relative API URLs", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    await createApi(fetcher).request("api/health");
    expect(fetcher).toHaveBeenCalledWith("./api/health", expect.any(Object));
  });

  it("loads a selected root directory", async () => {
    const api = { request: vi.fn().mockResolvedValue({ entries: [{ name: "automations", path: "automations", type: "directory" }] }) };
    const state = createExplorerState(api);
    await state.loadDirectory("config", "");
    expect(state.selectedRoot).toBe("config");
    expect(state.entries.get("config:")?.[0].name).toBe("automations");
  });

  it("bounds keyboard tree movement", () => {
    expect(nextTreeIndex(0, "ArrowUp", 3)).toBe(0);
    expect(nextTreeIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextTreeIndex(2, "ArrowDown", 3)).toBe(2);
    expect(nextTreeIndex(2, "Home", 3)).toBe(0);
    expect(nextTreeIndex(0, "End", 3)).toBe(2);
  });

  it("builds safe parent paths and clickable breadcrumbs", () => {
    expect(parentPath("")).toBe("");
    expect(parentPath("media")).toBe("");
    expect(parentPath("media/photos/2026")).toBe("media/photos");
    expect(breadcrumbSegments("media/photos")).toEqual([
      { label: "Root", path: "" },
      { label: "media", path: "media" },
      { label: "photos", path: "media/photos" },
    ]);
  });

  it("preserves dirty text when a save conflicts", async () => {
    const api = {
      request: vi.fn()
        .mockResolvedValueOnce({ content: "alias: Morning\n", signature: "sig-1" })
        .mockRejectedValueOnce(Object.assign(new Error("Changed"), { code: "FILE_CHANGED" })),
    };
    const editor = createEditorState(api);
    await editor.open("config", "automations/morning.yaml");
    editor.update("alias: Updated\n");
    expect(editor.dirty).toBe(true);
    await expect(editor.save()).rejects.toMatchObject({ code: "FILE_CHANGED" });
    expect(editor.content).toBe("alias: Updated\n");
    expect(editor.dirty).toBe(true);
  });

  it("requires confirmation before permanent purge", async () => {
    const api = { request: vi.fn() };
    const operations = createOperations(api);
    await operations.purge("trash-1", false);
    expect(api.request).not.toHaveBeenCalled();
    await operations.purge("trash-1", true);
    expect(api.request).toHaveBeenCalledWith("api/trash/trash-1", { method: "DELETE" });
  });
});
