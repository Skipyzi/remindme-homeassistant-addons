import { createApi } from "./api.js";
import { createEditorState } from "./editor.js";
import { createOperations } from "./operations.js";
import { createExplorerState, nextTreeIndex } from "./tree.js";

const api = createApi();
const state = createExplorerState(api);
const editor = createEditorState(api);
const operations = createOperations(api);
const elements = {
  app: document.querySelector("#app"), roots: document.querySelector("[data-roots]"), tree: document.querySelector("[data-tree]"),
  path: document.querySelector("[data-path]"), status: document.querySelector("[data-status]"), pane: document.querySelector("[data-tree-pane]"),
  scrim: document.querySelector("[data-scrim]"), content: document.querySelector("[data-content]"), fileName: document.querySelector("[data-file-name]"),
};
let currentEntry = null;
let searchController;

function setStatus(message, error = false) { elements.status.textContent = message; elements.status.style.color = error ? "var(--fe-error)" : ""; }
function closeTree() { elements.pane.dataset.open = "false"; elements.scrim.hidden = true; }
function openTree() { elements.pane.dataset.open = "true"; elements.scrim.hidden = false; }
document.querySelector("[data-open-tree]").addEventListener("click", openTree);
document.querySelector("[data-close-tree]").addEventListener("click", closeTree);
elements.scrim.addEventListener("click", closeTree);

function renderRoots() {
  elements.roots.replaceChildren(...state.roots.map((root) => {
    const button = document.createElement("button");
    button.className = "root-tab"; button.textContent = root.label;
    button.setAttribute("aria-current", String(root.id === state.selectedRoot));
    button.addEventListener("click", () => loadDirectory(root.id, ""));
    return button;
  }));
}
function formatSize(size) { return size < 1024 ? `${size} B` : size < 1048576 ? `${Math.round(size / 1024)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
function renderTree(entries) {
  elements.tree.replaceChildren(...entries.map((entry, index) => {
    const button = document.createElement("button");
    button.className = "tree-item"; button.setAttribute("role", "treeitem"); button.tabIndex = index === 0 ? 0 : -1;
    button.innerHTML = `<span aria-hidden="true">${entry.type === "directory" ? "▸" : "·"}</span><span></span><span class="meta"></span>`;
    button.children[1].textContent = entry.name; button.children[2].textContent = entry.type === "file" ? formatSize(entry.size) : "";
    button.addEventListener("click", () => entry.type === "directory" ? loadDirectory(state.selectedRoot, entry.path) : openFile(entry));
    button.addEventListener("keydown", (event) => {
      const items = [...elements.tree.querySelectorAll("[role=treeitem]")];
      const next = nextTreeIndex(items.indexOf(button), event.key, items.length);
      if (next !== items.indexOf(button)) { event.preventDefault(); button.tabIndex = -1; items[next].tabIndex = 0; items[next].focus(); }
      if (event.key === "Enter") button.click();
    });
    return button;
  }));
}
async function loadDirectory(root, path) {
  if (editor.dirty && !confirm("Discard unsaved changes?")) return;
  try {
    setStatus("Loading…"); const entries = await state.loadDirectory(root, path);
    editor.discard(); currentEntry = null; elements.path.textContent = path ? `/${path}` : "/";
    renderRoots(); renderTree(entries); setStatus(`${entries.length} item${entries.length === 1 ? "" : "s"}`); closeTree();
  } catch (error) { setStatus(error.message, true); }
}

function renderEditor() {
  elements.fileName.textContent = currentEntry.name;
  const wrap = document.createElement("div"); wrap.className = "editor-shell";
  const toolbar = document.createElement("div"); toolbar.className = "editor-toolbar";
  const dirty = document.createElement("span"); dirty.className = "dirty-mark"; dirty.textContent = "Unsaved"; dirty.hidden = !editor.dirty;
  const save = document.createElement("button"); save.className = "primary"; save.textContent = "Save changes";
  const download = document.createElement("a"); download.textContent = "Download"; download.href = operations.downloadUrl(state.selectedRoot, currentEntry.path);
  const move = document.createElement("button"); move.textContent = "Move / rename";
  const remove = document.createElement("button"); remove.className = "danger"; remove.textContent = "Move to trash";
  toolbar.append(dirty, download, move, remove, save);
  const textarea = document.createElement("textarea"); textarea.className = "file-editor"; textarea.value = editor.content; textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "File content editor");
  textarea.addEventListener("input", () => { editor.update(textarea.value); dirty.hidden = !editor.dirty; });
  save.addEventListener("click", async () => { try { setStatus("Saving…"); await editor.save(); dirty.hidden = true; setStatus("Saved · backup created"); } catch (error) { setStatus(error.code === "FILE_CHANGED" ? "File changed outside the editor. Your text is preserved; reload or save under another name." : error.message, true); } });
  move.addEventListener("click", async () => { const target = prompt("New relative path", currentEntry.path); if (!target || target === currentEntry.path) return; try { await operations.move(state.selectedRoot, currentEntry.path, target); editor.discard(); await loadDirectory(state.selectedRoot, state.selectedPath); } catch (error) { setStatus(error.message, true); } });
  remove.addEventListener("click", async () => { if (!confirm(`Move ${currentEntry.name} to trash?`)) return; try { await operations.trash(state.selectedRoot, currentEntry.path); editor.discard(); await loadDirectory(state.selectedRoot, state.selectedPath); } catch (error) { setStatus(error.message, true); } });
  wrap.append(toolbar, textarea); elements.content.replaceWith(wrap); elements.content = wrap;
}

async function openFile(entry) {
  if (editor.dirty && !confirm("Discard unsaved changes?")) return;
  currentEntry = entry;
  const image = /\.(png|jpe?g|gif|webp|svg)$/i.test(entry.name);
  if (image) {
    editor.discard(); elements.fileName.textContent = entry.name;
    const preview = document.createElement("div"); preview.className = "preview-shell";
    const img = document.createElement("img"); img.src = operations.downloadUrl(state.selectedRoot, entry.path); img.alt = entry.name;
    preview.append(img); elements.content.replaceWith(preview); elements.content = preview; closeTree(); return;
  }
  try { await editor.open(state.selectedRoot, entry.path, { force: true }); renderEditor(); closeTree(); setStatus(`${formatSize(entry.size)} · UTF-8`); }
  catch (error) { setStatus(error.message, true); }
}

document.querySelector("[data-refresh]").addEventListener("click", () => loadDirectory(state.selectedRoot, state.selectedPath));
document.querySelector("[data-new]").addEventListener("click", async () => {
  const name = prompt("Name for the new file or folder"); if (!name) return;
  const type = confirm("Create a folder? Choose Cancel for a file.") ? "directory" : "file";
  const target = state.selectedPath ? `${state.selectedPath}/${name}` : name;
  try { await operations.create(state.selectedRoot, target, type); await loadDirectory(state.selectedRoot, state.selectedPath); } catch (error) { setStatus(error.message, true); }
});
const uploadInput = document.querySelector("[data-upload-input]");
document.querySelector("[data-upload]").addEventListener("click", () => uploadInput.click());
uploadInput.addEventListener("change", async () => { const file = uploadInput.files[0]; if (!file) return; const target = state.selectedPath ? `${state.selectedPath}/${file.name}` : file.name; try { setStatus("Uploading…"); await operations.upload(state.selectedRoot, target, file); await loadDirectory(state.selectedRoot, state.selectedPath); } catch (error) { setStatus(error.message, true); } finally { uploadInput.value = ""; } });
document.querySelector("[data-search]").addEventListener("click", async () => {
  const query = prompt("Search names and text"); if (!query) return; searchController?.abort(); searchController = new AbortController();
  try { setStatus("Searching…"); const result = await operations.search(state.selectedRoot, state.selectedPath, query, searchController.signal); renderTree(result.results.map((item) => ({ ...item, name: item.path.split("/").at(-1), size: 0 }))); setStatus(`${result.results.length} result${result.results.length === 1 ? "" : "s"}${result.truncated ? " · limited" : ""}`); } catch (error) { if (error.name !== "AbortError") setStatus(error.message, true); }
});
document.querySelector("[data-trash]").addEventListener("click", async () => {
  try {
    const result = await operations.listTrash(); elements.fileName.textContent = "Trash";
    const list = document.createElement("div"); list.className = "trash-list";
    for (const item of result.items) {
      const row = document.createElement("div"); row.className = "trash-row"; row.innerHTML = `<span></span><small></small>`; row.children[0].textContent = item.originalPath; row.children[1].textContent = new Date(item.deletedAt).toLocaleString();
      const restore = document.createElement("button"); restore.textContent = "Restore"; restore.addEventListener("click", async () => { try { await operations.restore(item.id); document.querySelector("[data-trash]").click(); } catch (error) { const alternate = prompt(error.message + "\nAlternate relative path"); if (alternate) { await operations.restore(item.id, alternate); document.querySelector("[data-trash]").click(); } } });
      const purge = document.createElement("button"); purge.className = "danger"; purge.textContent = "Delete forever"; purge.addEventListener("click", async () => { if (confirm(`Permanently delete ${item.originalPath}?`)) { await operations.purge(item.id, true); document.querySelector("[data-trash]").click(); } });
      row.append(restore, purge); list.append(row);
    }
    elements.content.replaceWith(list); elements.content = list; setStatus(`${result.items.length} trash item${result.items.length === 1 ? "" : "s"}`);
  } catch (error) { setStatus(error.message, true); }
});

try { await state.loadRoots(); if (state.roots.length) await loadDirectory(state.roots[0].id, ""); else setStatus("No storage roots are enabled", true); }
catch (error) { setStatus(error.message, true); }
finally { elements.app.setAttribute("aria-busy", "false"); }
