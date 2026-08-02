// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
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

  it("attaches the vault token only to explicitly Host-scoped requests", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }));
    const api = createApi(fetcher, { getVaultToken: () => "browser-token" });

    await api.request("api/health");
    expect(fetcher).toHaveBeenLastCalledWith("./api/health", expect.objectContaining({ headers: {} }));
    await api.request("api/entries?root=host", { hostVault: true });
    expect(fetcher).toHaveBeenLastCalledWith("./api/entries?root=host", expect.objectContaining({
      headers: { "X-File-Explorer-Vault": "browser-token" },
    }));
  });

  it("exposes the Host Vault API operations", async () => {
    const api = { request: vi.fn() };
    const operations = createOperations(api);

    operations.hostVaultStatus();
    expect(api.request).toHaveBeenLastCalledWith("api/host-vault/status", { hostVault: true });
    operations.setupHostVault({ host: "gateway" });
    expect(api.request).toHaveBeenLastCalledWith("api/host-vault/setup", { method: "POST", body: JSON.stringify({ host: "gateway" }) });
    operations.unlockHostVault("secret");
    expect(api.request).toHaveBeenLastCalledWith("api/host-vault/unlock", { method: "POST", body: JSON.stringify({ passphrase: "secret" }) });
    operations.lockHostVault();
    expect(api.request).toHaveBeenLastCalledWith("api/host-vault/lock", { method: "POST", hostVault: true });
    operations.resetHostVault("RESET HOST VAULT");
    expect(api.request).toHaveBeenLastCalledWith("api/host-vault", { method: "DELETE", body: JSON.stringify({ confirmation: "RESET HOST VAULT" }) });
  });

  it("marks only Host directory loads as vault-scoped", async () => {
    const api = { request: vi.fn().mockResolvedValue({ entries: [] }) };
    const state = createExplorerState(api);

    await state.loadDirectory("config", "automations");
    expect(api.request).toHaveBeenLastCalledWith("api/entries?root=config&path=automations", { hostVault: false });
    await state.loadDirectory("host", "etc");
    expect(api.request).toHaveBeenLastCalledWith("api/entries?root=host&path=etc", { hostVault: true });
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

  it("marks Host text, search, and storage operations as vault-scoped", async () => {
    const api = { request: vi.fn().mockResolvedValue({ content: "NAME=HAOS\n", signature: "sig" }) };
    const editor = createEditorState(api);
    await editor.open("host", "etc/os-release");
    expect(api.request).toHaveBeenLastCalledWith("api/text?root=host&path=etc%2Fos-release", { hostVault: true });

    const operations = createOperations(api);
    operations.search("host", "etc", "HAOS", new AbortController().signal);
    expect(api.request).toHaveBeenLastCalledWith(expect.stringContaining("api/search?root=host"), expect.objectContaining({ hostVault: true }));
    operations.startStorageScan("host", "mnt/data", true);
    expect(api.request).toHaveBeenLastCalledWith("api/storage-map/scans", {
      method: "POST",
      body: JSON.stringify({ root: "host", path: "mnt/data", refresh: true }),
      hostVault: true,
    });
  });

  it("uses authenticated blobs for Host downloads and previews", async () => {
    const response = () => new Response(new Blob(["host file"]), { status: 200 });
    const api = { request: vi.fn(async () => response()) };
    const operations = createOperations(api);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn() });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:host-file");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await operations.download("host", "etc/os-release");
    expect(api.request).toHaveBeenCalledWith("api/download?root=host&path=etc%2Fos-release", { hostVault: true });
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();

    await expect(operations.previewUrl("host", "usr/share/image.png")).resolves.toBe("blob:host-file");
    operations.revokePreview("blob:host-file");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:host-file");
    createObjectURL.mockRestore(); revokeObjectURL.mockRestore(); click.mockRestore();
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

  it("integrates Host Vault root selection into the application", async () => {
    const appSource = await readFile(path.resolve("public/app.js"), "utf8");
    expect(appSource).toContain('from "./host-vault.js"');
    expect(appSource).toContain("createHostVaultController(");
    expect(appSource).toContain("selectRoot(root)");
  });

  it("binds the context menu controller to rendered file rows", async () => {
    const appSource = await readFile(path.resolve("public/app.js"), "utf8");
    expect(appSource).toContain('from "./context-menu.js"');
    expect(appSource).toContain("createContextMenu(");
    expect(appSource).toContain("contextMenu.bind(button, entry, root)");
  });

  it("downloads a selected file through an ingress-relative link", async () => {
    const api = { request: vi.fn() };
    const operations = createOperations(api);
    const clicked: Array<{ href: string; download: string }> = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.getAttribute("href") ?? "", download: this.download });
    });

    await operations.download("config", "automations/morning.yaml");

    expect(clicked).toEqual([{
      href: "./api/download?root=config&path=automations%2Fmorning.yaml",
      download: "morning.yaml",
    }]);
    click.mockRestore();
  });

  it("uses the storage scan job API contract", async () => {
    const api = { request: vi.fn() };
    const operations = createOperations(api);

    operations.startStorageScan("share", "", true);
    expect(api.request).toHaveBeenLastCalledWith("api/storage-map/scans", {
      method: "POST",
      body: JSON.stringify({ root: "share", path: "", refresh: true }),
      hostVault: false,
    });
    operations.storageScanStatus("job/1");
    expect(api.request).toHaveBeenLastCalledWith("api/storage-map/scans/job%2F1", { hostVault: false });
    operations.storageScanResult("job/1", "media/photos");
    expect(api.request).toHaveBeenLastCalledWith("api/storage-map/scans/job%2F1/result?path=media%2Fphotos", { hostVault: false });
    operations.cancelStorageScan("job/1");
    expect(api.request).toHaveBeenLastCalledWith("api/storage-map/scans/job%2F1", { method: "DELETE", hostVault: false });
  });
});
