// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionsForEntry, createContextMenu, createEntryActionHandlers } from "../public/context-menu.js";

const actionIds = (entry, root) => actionsForEntry(entry, root).map(({ id }) => id);

describe("entry context action policy", () => {
  it("offers the complete local file actions", () => {
    expect(actionIds({ type: "file" }, { id: "config", readOnly: false })).toEqual([
      "open", "preview-edit", "download", "move", "copy-path", "storage-details", "trash",
    ]);
  });

  it("offers the complete local folder actions", () => {
    expect(actionIds({ type: "directory" }, { id: "share", readOnly: false })).toEqual([
      "open", "new-file", "new-folder", "upload", "move", "copy-path", "map-folder", "trash",
    ]);
  });

  it("omits every mutation from Host files", () => {
    expect(actionIds({ type: "file" }, { id: "host", readOnly: true })).toEqual([
      "open-readonly", "download", "copy-path", "storage-details", "show-in-map",
    ]);
  });

  it("omits every mutation from Host folders", () => {
    expect(actionIds({ type: "directory" }, { id: "host", readOnly: true })).toEqual([
      "open", "copy-path", "map-folder",
    ]);
  });
});

function pointerEvent(type, values = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(values)) Object.defineProperty(event, name, { value });
  return event;
}

describe("entry context action dispatch", () => {
  function setup() {
    const operations = {
      create: vi.fn(),
      download: vi.fn(),
      move: vi.fn(),
      trash: vi.fn(),
    };
    const dependencies = {
      operations,
      openFile: vi.fn(),
      loadDirectory: vi.fn(),
      openStorageMap: vi.fn(),
      copyText: vi.fn(),
      prompt: vi.fn(),
      confirm: vi.fn(() => true),
      setUploadDestination: vi.fn(),
      showStorageDetails: vi.fn(),
      refreshDirectory: vi.fn(),
    };
    return { operations, dependencies, handlers: createEntryActionHandlers(dependencies) };
  }

  it("dispatches file downloads, folder maps, and trash", async () => {
    const { operations, dependencies, handlers } = setup();
    const root = { id: "config", readOnly: false };
    const file = { name: "notes.txt", path: "notes.txt", type: "file", size: 8 };
    const folder = { name: "photos", path: "media/photos", type: "directory" };

    await handlers.run("download", file, root);
    expect(operations.download).toHaveBeenCalledWith("config", "notes.txt");

    await handlers.run("map-folder", folder, root);
    expect(dependencies.openStorageMap).toHaveBeenCalledWith("config", "media/photos");

    await handlers.run("trash", file, root);
    expect(operations.trash).toHaveBeenCalledWith("config", "notes.txt");
    expect(dependencies.refreshDirectory).toHaveBeenCalled();
  });

  it("creates items and uploads inside the selected folder", async () => {
    const { operations, dependencies, handlers } = setup();
    const root = { id: "share", readOnly: false };
    const folder = { name: "photos", path: "media/photos", type: "directory" };
    dependencies.prompt.mockReturnValueOnce("cover.jpg").mockReturnValueOnce("edited");

    await handlers.run("new-file", folder, root);
    expect(operations.create).toHaveBeenCalledWith("share", "media/photos/cover.jpg", "file");
    await handlers.run("new-folder", folder, root);
    expect(operations.create).toHaveBeenCalledWith("share", "media/photos/edited", "directory");
    await handlers.run("upload", folder, root);
    expect(dependencies.setUploadDestination).toHaveBeenCalledWith("media/photos");
  });

  it("blocks crafted mutation action IDs on read-only roots", async () => {
    const { operations, handlers } = setup();
    const host = { id: "host", readOnly: true };
    const file = { name: "os-release", path: "etc/os-release", type: "file" };

    await expect(handlers.run("trash", file, host)).rejects.toThrow("read-only");
    expect(operations.trash).not.toHaveBeenCalled();
  });
});

describe("entry context menu interaction", () => {
  let menu;
  let row;
  let controller;
  let onAction;

  beforeEach(() => {
    document.body.innerHTML = '<button class="tree-item">notes.txt</button><div data-context-menu role="menu" hidden></div>';
    row = document.querySelector(".tree-item");
    menu = document.querySelector("[data-context-menu]");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 600 });
    Object.defineProperty(menu, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 220, height: 280, left: 0, top: 0, right: 220, bottom: 280 }),
    });
    Object.defineProperty(row, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 740, top: 560, right: 790, bottom: 590, width: 50, height: 30 }),
    });
    onAction = vi.fn();
    controller = createContextMenu({ element: menu, onAction, longPressMs: 550 });
    controller.bind(row, { name: "notes.txt", path: "notes.txt", type: "file" }, { id: "config", readOnly: false });
  });

  afterEach(() => {
    controller.destroy();
    vi.useRealTimers();
  });

  it("opens on right-click, clamps to the viewport, and focuses the first action", () => {
    const allowed = row.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 790,
      clientY: 590,
    }));

    expect(allowed).toBe(false);
    expect(menu.hidden).toBe(false);
    expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(572);
    expect(Number.parseFloat(menu.style.top)).toBeLessThanOrEqual(312);
    expect(menu.querySelector('[role="menuitem"]')).toBe(document.activeElement);
  });

  it("supports keyboard navigation, activation, Escape, and focus restoration", async () => {
    row.focus();
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1].click();
    await Promise.resolve();
    expect(onAction).toHaveBeenCalledWith("preview-edit", expect.objectContaining({ path: "notes.txt" }), expect.objectContaining({ id: "config" }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(row);

    row.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it("opens after a deliberate long press without also activating the row", async () => {
    vi.useFakeTimers();
    const activateRow = vi.fn();
    row.addEventListener("click", activateRow);
    row.dispatchEvent(pointerEvent("pointerdown", { pointerType: "touch", pointerId: 1, clientX: 40, clientY: 50 }));
    await vi.advanceTimersByTimeAsync(550);
    expect(menu.hidden).toBe(false);
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(activateRow).not.toHaveBeenCalled();

    controller.close({ restoreFocus: false });
    row.dispatchEvent(pointerEvent("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 40, clientY: 50 }));
    row.dispatchEvent(pointerEvent("pointermove", { pointerType: "touch", pointerId: 2, clientX: 70, clientY: 50 }));
    await vi.advanceTimersByTimeAsync(550);
    expect(menu.hidden).toBe(true);
  });
});
