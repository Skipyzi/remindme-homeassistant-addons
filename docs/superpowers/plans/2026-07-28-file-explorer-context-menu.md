# File Explorer Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an expanded, accessible context menu for local and Host file/folder rows.

**Architecture:** A pure action-policy function determines actions from root/read-only/type metadata. A DOM controller owns right-click, keyboard, long-press, viewport positioning, focus, and dismissal; `app.js` maps action IDs onto existing operations so the menu cannot bypass backend authorization.

**Tech Stack:** Browser-native ES modules, CSS, jsdom, Vitest.

## Global Constraints

- Host entries never receive mutation action IDs.
- Native context menus are prevented only on File Explorer rows.
- Support right-click, Context Menu key, `Shift+F10`, and long press.
- Restore focus to the originating row after close.
- Reuse existing editor, trash, upload, move, and storage-map operations.

---

### Task 1: Define context-sensitive action policy

**Files:**
- Create: `file-explorer/public/context-menu.js`
- Create: `file-explorer/test/context-menu.test.mjs`

**Interfaces:**
- Produces: `actionsForEntry(entry, root): ContextAction[]`
- `ContextAction`: `{ id: string, label: string, danger?: boolean }`

- [ ] **Step 1: Write failing action-set tests**

```js
expect(actionsForEntry({ type: "file" }, { id: "config", readOnly: false }).map(({ id }) => id)).toEqual([
  "open", "preview-edit", "download", "move", "copy-path", "storage-details", "trash",
]);
expect(actionsForEntry({ type: "directory" }, { id: "share", readOnly: false }).map(({ id }) => id)).toEqual([
  "open", "new-file", "new-folder", "upload", "move", "copy-path", "map-folder", "trash",
]);
expect(actionsForEntry({ type: "file" }, { id: "host", readOnly: true }).map(({ id }) => id)).toEqual([
  "open-readonly", "download", "copy-path", "storage-details", "show-in-map",
]);
expect(actionsForEntry({ type: "directory" }, { id: "host", readOnly: true }).map(({ id }) => id)).toEqual([
  "open", "copy-path", "map-folder",
]);
```

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/context-menu.test.mjs`

Expected: module is missing.

- [ ] **Step 3: Implement exact policy**

Use frozen action definitions and return new arrays. Treat any `root.readOnly` root with the Host sets so future read-only roots cannot accidentally receive mutations. Preserve the Host-specific `open-readonly` label when `root.id === "host"`.

- [ ] **Step 4: Verify and commit**

Run: `pnpm vitest run test/context-menu.test.mjs`

```sh
git add file-explorer/public/context-menu.js file-explorer/test/context-menu.test.mjs
git commit -m "feat(file-explorer): define row context actions"
```

---

### Task 2: Implement accessible menu interaction

**Files:**
- Modify: `file-explorer/public/context-menu.js`
- Modify: `file-explorer/public/index.html`
- Modify: `file-explorer/public/styles.css`
- Modify: `file-explorer/test/context-menu.test.mjs`
- Modify: `file-explorer/test/server.test.ts`

**Interfaces:**
- Produces: `createContextMenu({ element, onAction, longPressMs }): ContextMenuController`
- Controller: `bind(row, entry, root)`, `close({ restoreFocus })`, `destroy()`
- DOM hook: `[data-context-menu]`

- [ ] **Step 1: Write failing interaction tests**

In jsdom, create two rows and assert:

```js
row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 900, clientY: 700 }));
expect(menu.hidden).toBe(false);
expect(menu.querySelector('[role="menuitem"]')).toBe(document.activeElement);
expect(Number.parseFloat(menu.style.left)).toBeLessThanOrEqual(window.innerWidth);

row.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
expect(menu.hidden).toBe(false);
menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
expect(document.activeElement).toBe(menu.querySelectorAll('[role="menuitem"]')[1]);
menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
expect(menu.hidden).toBe(true);
expect(document.activeElement).toBe(row);
```

Use fake timers for a 550 ms pointer/touch long press and verify pointer movement/cancel prevents opening.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/context-menu.test.mjs test/server.test.ts`

Expected: controller and markup hook are absent.

- [ ] **Step 3: Add semantic menu shell**

Add once near the end of `main`:

```html
<div class="entry-context-menu" data-context-menu role="menu" hidden aria-label="File actions"></div>
```

- [ ] **Step 4: Implement interaction controller**

The controller must:

- bind listeners with an `AbortController` per row;
- render buttons with `role="menuitem"` and `data-context-action`;
- set danger styling only from action policy;
- clamp left/top after measuring the rendered menu;
- open at the row rect for keyboard activation;
- use a 550 ms long-press timer and 10 px movement tolerance;
- close on outside pointerdown, Escape, action, and focusout to a non-menu/non-origin element;
- move with ArrowUp/ArrowDown/Home/End;
- activate with Enter/Space;
- restore origin focus except when the selected action intentionally moves focus.

- [ ] **Step 5: Add responsive styling**

Desktop uses a compact elevated menu with Home Assistant variables. Below 720 px, use a fixed bottom sheet with 44 px actions. Add `.entry-context-menu[hidden] { display: none; }`, visible focus, danger color, and reduced-motion handling.

- [ ] **Step 6: Verify and commit**

Run:

```sh
pnpm vitest run test/context-menu.test.mjs test/server.test.ts
node --check public/context-menu.js
```

```sh
git add file-explorer/public/context-menu.js file-explorer/public/index.html file-explorer/public/styles.css file-explorer/test/context-menu.test.mjs file-explorer/test/server.test.ts
git commit -m "feat(file-explorer): add accessible row context menu"
```

---

### Task 3: Wire actions to existing explorer behavior

**Files:**
- Modify: `file-explorer/public/app.js`
- Modify: `file-explorer/public/operations.js`
- Modify: `file-explorer/public/context-menu.js`
- Modify: `file-explorer/test/context-menu.test.mjs`
- Modify: `file-explorer/test/ui.test.ts`

**Interfaces:**
- Consumes: current root, selected path, entry metadata, editor, operations, storage map
- Produces: one `handleContextAction(actionId, entry)` dispatcher

- [ ] **Step 1: Write failing dispatch tests**

Extract/export a dispatcher factory to permit real behavior tests without executing the whole app:

```js
const handlers = createEntryActionHandlers({ operations, openFile, loadDirectory, openStorageMap, copyText, prompt, confirm });
await handlers.run("download", file, root, "");
expect(operations.download).toHaveBeenCalledWith("config", "notes.txt");
await handlers.run("map-folder", folder, root, "");
expect(openStorageMap).toHaveBeenCalledWith("config", "photos");
await handlers.run("trash", file, root, "");
expect(operations.trash).toHaveBeenCalledWith("config", "notes.txt");
```

Assert a Host mutation ID throws/rejects before calling operations even if manually supplied.

- [ ] **Step 2: Verify RED**

Run: `pnpm vitest run test/context-menu.test.mjs test/ui.test.ts`

Expected: dispatcher/download helper is missing.

- [ ] **Step 3: Implement dispatcher and row binding**

Add `operations.download(root, path, vault = false)` that fetches through the API and triggers an object-URL download; retain `downloadUrl` for local editor links until Host Vault replaces it.

Extract `createEntryActionHandlers` into `context-menu.js`. Bind every rendered tree row with the entry and selected root metadata. Implement actions by calling existing functions; use `navigator.clipboard.writeText` with a textarea fallback; show storage details in the content pane; use existing prompts/confirmations for create/move/trash; set upload destination before opening the file chooser.

For `map-folder`/`show-in-map`, call `storageMap.open(root.id, entry.type === "directory" ? entry.path : parentPath(entry.path))`.

- [ ] **Step 4: Verify all local actions**

Run:

```sh
pnpm vitest run test/context-menu.test.mjs test/ui.test.ts test/storage-map-ui.test.mjs
pnpm test
```

Expected: action dispatch and all existing behavior pass.

- [ ] **Step 5: Commit**

```sh
git add file-explorer/public/app.js file-explorer/public/operations.js file-explorer/public/context-menu.js file-explorer/test/context-menu.test.mjs file-explorer/test/ui.test.ts
git commit -m "feat(file-explorer): connect row context actions"
```
