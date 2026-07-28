export function createExplorerState(api) {
  return {
    roots: [],
    selectedRoot: null,
    selectedPath: "",
    entries: new Map(),
    expanded: new Set(),
    async loadRoots() {
      const result = await api.request("api/roots");
      this.roots = result.roots;
      return this.roots;
    },
    async loadDirectory(root, path) {
      const result = await api.request(`api/entries?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      this.selectedRoot = root;
      this.selectedPath = path;
      this.entries.set(`${root}:${path}`, result.entries);
      return result.entries;
    },
  };
}

export function parentPath(relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function breadcrumbSegments(relativePath) {
  const segments = [{ label: "Root", path: "" }];
  const parts = relativePath.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    segments.push({ label: part, path: current });
  }
  return segments;
}

export function nextTreeIndex(current, key, count) {
  if (count <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === "ArrowUp") return Math.max(0, current - 1);
  if (key === "ArrowDown") return Math.min(count - 1, current + 1);
  return current;
}
