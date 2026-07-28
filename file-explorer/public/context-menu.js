const ACTIONS = Object.freeze({
  open: { id: "open", label: "Open" },
  "open-readonly": { id: "open-readonly", label: "Open read-only" },
  "preview-edit": { id: "preview-edit", label: "Preview / edit" },
  download: { id: "download", label: "Download" },
  move: { id: "move", label: "Move / rename" },
  "copy-path": { id: "copy-path", label: "Copy path" },
  "storage-details": { id: "storage-details", label: "Storage details" },
  trash: { id: "trash", label: "Move to trash", danger: true },
  "new-file": { id: "new-file", label: "New file" },
  "new-folder": { id: "new-folder", label: "New folder" },
  upload: { id: "upload", label: "Upload here" },
  "map-folder": { id: "map-folder", label: "Map this folder" },
  "show-in-map": { id: "show-in-map", label: "Show in storage map" },
});

const LOCAL_FILE_ACTIONS = [
  "open",
  "preview-edit",
  "download",
  "move",
  "copy-path",
  "storage-details",
  "trash",
];
const LOCAL_DIRECTORY_ACTIONS = [
  "open",
  "new-file",
  "new-folder",
  "upload",
  "move",
  "copy-path",
  "map-folder",
  "trash",
];
const READ_ONLY_FILE_ACTIONS = [
  "open-readonly",
  "download",
  "copy-path",
  "storage-details",
  "show-in-map",
];
const READ_ONLY_DIRECTORY_ACTIONS = ["open", "copy-path", "map-folder"];

export function actionsForEntry(entry, root) {
  const actionIds = root.readOnly
    ? entry.type === "directory" ? READ_ONLY_DIRECTORY_ACTIONS : READ_ONLY_FILE_ACTIONS
    : entry.type === "directory" ? LOCAL_DIRECTORY_ACTIONS : LOCAL_FILE_ACTIONS;
  return actionIds.map((id) => ({ ...ACTIONS[id] }));
}

function childPath(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

function parentPath(relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function createEntryActionHandlers({
  operations,
  openFile,
  loadDirectory,
  openStorageMap,
  copyText,
  prompt,
  confirm,
  setUploadDestination,
  showStorageDetails,
  refreshDirectory,
}) {
  async function run(actionId, entry, root) {
    const allowed = actionsForEntry(entry, root).some((action) => action.id === actionId);
    if (!allowed) throw new Error(root.readOnly ? "Action is unavailable on a read-only root" : "Action is unavailable");

    if (actionId === "open" || actionId === "open-readonly" || actionId === "preview-edit") {
      return entry.type === "directory" ? loadDirectory(root.id, entry.path) : openFile(entry);
    }
    if (actionId === "download") return operations.download(root.id, entry.path);
    if (actionId === "copy-path") return copyText(root.id === "host" ? `/${entry.path}` : entry.path);
    if (actionId === "storage-details") return showStorageDetails(entry, root);
    if (actionId === "map-folder") return openStorageMap(root.id, entry.path);
    if (actionId === "show-in-map") return openStorageMap(root.id, parentPath(entry.path));
    if (actionId === "upload") return setUploadDestination(entry.path);

    if (actionId === "move") {
      const target = prompt("New relative path", entry.path);
      if (!target || target === entry.path) return;
      await operations.move(root.id, entry.path, target);
      return refreshDirectory();
    }
    if (actionId === "trash") {
      if (!confirm(`Move ${entry.name} to trash?`)) return;
      await operations.trash(root.id, entry.path);
      return refreshDirectory();
    }
    if (actionId === "new-file" || actionId === "new-folder") {
      const type = actionId === "new-folder" ? "directory" : "file";
      const name = prompt(`Name for the new ${type === "file" ? "file" : "folder"}`);
      if (!name) return;
      await operations.create(root.id, childPath(entry.path, name), type);
      return refreshDirectory();
    }
  }

  return { run };
}

export function createContextMenu({ element, onAction, longPressMs = 550 }) {
  const globalEvents = new AbortController();
  const rowEvents = new Set();
  let origin = null;
  let entry = null;
  let root = null;
  let longPressTimer = null;
  let longPressStart = null;

  function cancelLongPress() {
    if (longPressTimer !== null) window.clearTimeout(longPressTimer);
    longPressTimer = null;
    longPressStart = null;
  }

  function close({ restoreFocus = true } = {}) {
    cancelLongPress();
    element.hidden = true;
    element.replaceChildren();
    const previousOrigin = origin;
    origin = null;
    entry = null;
    root = null;
    if (restoreFocus && previousOrigin?.isConnected) previousOrigin.focus();
  }

  function menuItems() {
    return [...element.querySelectorAll('[role="menuitem"]')];
  }

  function openAt(row, selectedEntry, selectedRoot, x, y) {
    close({ restoreFocus: false });
    origin = row;
    entry = selectedEntry;
    root = selectedRoot;
    const buttons = actionsForEntry(entry, root).map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitem";
      button.dataset.contextAction = action.id;
      button.textContent = action.label;
      if (action.danger) button.classList.add("danger");
      return button;
    });
    element.replaceChildren(...buttons);
    element.hidden = false;
    element.style.left = "0px";
    element.style.top = "0px";
    const bounds = element.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - bounds.width - margin));
    const top = Math.max(margin, Math.min(y, window.innerHeight - bounds.height - margin));
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    buttons[0]?.focus();
  }

  function openFromKeyboard(row, selectedEntry, selectedRoot) {
    const bounds = row.getBoundingClientRect();
    openAt(row, selectedEntry, selectedRoot, bounds.left + 16, bounds.bottom);
  }

  element.addEventListener("click", (event) => {
    const button = event.target.closest("[data-context-action]");
    if (!button || !entry || !root) return;
    const actionId = button.dataset.contextAction;
    const selectedEntry = entry;
    const selectedRoot = root;
    close();
    void Promise.resolve(onAction(actionId, selectedEntry, selectedRoot));
  }, { signal: globalEvents.signal });

  element.addEventListener("keydown", (event) => {
    const items = menuItems();
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex = currentIndex;
    if (event.key === "ArrowDown") nextIndex = (Math.max(0, currentIndex) + 1) % items.length;
    if (event.key === "ArrowUp") nextIndex = (currentIndex <= 0 ? items.length : currentIndex) - 1;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = items.length - 1;
    if (nextIndex !== currentIndex && items[nextIndex]) {
      event.preventDefault();
      items[nextIndex].focus();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if ((event.key === "Enter" || event.key === " ") && document.activeElement?.matches?.("[data-context-action]")) {
      event.preventDefault();
      document.activeElement.click();
    }
  }, { signal: globalEvents.signal });

  document.addEventListener("pointerdown", (event) => {
    if (!element.hidden && !element.contains(event.target) && event.target !== origin) close();
  }, { capture: true, signal: globalEvents.signal });

  element.addEventListener("focusout", () => {
    queueMicrotask(() => {
      if (!element.hidden && !element.contains(document.activeElement) && document.activeElement !== origin) close({ restoreFocus: false });
    });
  }, { signal: globalEvents.signal });

  function bind(row, selectedEntry, selectedRoot) {
    const events = new AbortController();
    rowEvents.add(events);
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openAt(row, selectedEntry, selectedRoot, event.clientX, event.clientY);
    }, { signal: events.signal });
    row.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        openFromKeyboard(row, selectedEntry, selectedRoot);
      }
    }, { signal: events.signal });
    row.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      cancelLongPress();
      longPressStart = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      longPressTimer = window.setTimeout(() => {
        if (!longPressStart) return;
        openAt(row, selectedEntry, selectedRoot, longPressStart.x, longPressStart.y);
        cancelLongPress();
      }, longPressMs);
    }, { signal: events.signal });
    row.addEventListener("pointermove", (event) => {
      if (!longPressStart || event.pointerId !== longPressStart.pointerId) return;
      if (Math.hypot(event.clientX - longPressStart.x, event.clientY - longPressStart.y) > 10) cancelLongPress();
    }, { signal: events.signal });
    for (const type of ["pointerup", "pointercancel"]) {
      row.addEventListener(type, cancelLongPress, { signal: events.signal });
    }
    return () => {
      events.abort();
      rowEvents.delete(events);
    };
  }

  function destroy() {
    close({ restoreFocus: false });
    globalEvents.abort();
    for (const events of rowEvents) events.abort();
    rowEvents.clear();
  }

  return { bind, close, destroy };
}
