import { layoutTreemap } from "./treemap.js";

const TYPE_LABELS = {
  model: "Models",
  archive: "Archives",
  video: "Video",
  audio: "Audio",
  image: "Images",
  text: "Text",
  other: "Other",
};

function parentPath(relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function pathSegments(relativePath) {
  const segments = [{ label: "Root", path: "" }];
  let current = "";
  for (const part of relativePath.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    segments.push({ label: part, path: current });
  }
  return segments;
}

function reasonLabel(reason) {
  if (reason === "entry_limit") return "entry limit reached";
  if (reason === "timeout") return "scan timed out";
  if (reason === "cancelled") return "scan cancelled";
  if (reason === "unreadable_entries") return "unreadable entries skipped";
  return "scan incomplete";
}

export function createStorageMap({
  operations,
  onOpenFile,
  onClose,
  formatSize,
  pollDelay = 500,
  getBounds = (element) => element.getBoundingClientRect(),
}) {
  const elements = {
    view: document.querySelector("[data-storage-map]"),
    close: document.querySelector("[data-storage-close]"),
    up: document.querySelector("[data-storage-up]"),
    root: document.querySelector("[data-storage-root]"),
    breadcrumbs: document.querySelector("[data-storage-breadcrumbs]"),
    refresh: document.querySelector("[data-storage-refresh]"),
    cancel: document.querySelector("[data-storage-cancel]"),
    age: document.querySelector("[data-storage-age]"),
    summary: document.querySelector("[data-storage-summary]"),
    legend: document.querySelector("[data-storage-legend]"),
    canvas: document.querySelector("[data-storage-canvas]"),
    details: document.querySelector("[data-storage-details]"),
    status: document.querySelector("[data-storage-status]"),
  };
  let selectedRoot = null;
  let jobId = null;
  let currentPath = "";
  let scanPath = "";
  let pollTimer = null;
  let isOpen = false;

  function clearPoll() {
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function setStatus(message, error = false) {
    elements.status.textContent = message;
    elements.status.dataset.error = String(error);
  }

  function showDetails(node) {
    const path = node.relativePath ?? "Grouped files";
    const percent = Number(elements.canvas.dataset.totalBytes) > 0
      ? `${((node.size / Number(elements.canvas.dataset.totalBytes)) * 100).toFixed(1)}%`
      : "0%";
    elements.details.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = node.name;
    const metadata = document.createElement("span");
    metadata.textContent = `${path} · ${formatSize(node.size)} · ${percent}`;
    elements.details.append(title, metadata);
    elements.details.hidden = false;
  }

  function renderBreadcrumbs(path) {
    const segments = pathSegments(path);
    elements.breadcrumbs.replaceChildren(...segments.map((segment, index) => {
      const button = document.createElement("button");
      button.textContent = segment.label;
      if (index === segments.length - 1) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => drill(segment.path));
      return button;
    }));
    elements.up.disabled = path === scanPath;
    elements.root.disabled = path === scanPath;
  }

  function renderLegend(nodes) {
    const groups = [...new Set(nodes.filter((node) => node.typeGroup !== "directory").map((node) => node.typeGroup))];
    elements.legend.replaceChildren(...groups.map((group) => {
      const item = document.createElement("span");
      item.className = `storage-legend-item type-${group}`;
      item.textContent = TYPE_LABELS[group] ?? "Other";
      return item;
    }));
  }

  function activateNode(node) {
    showDetails(node);
    if (!node.openable || node.kind === "aggregate") return;
    if (node.kind === "directory") {
      void drill(node.relativePath);
      return;
    }
    close();
    onOpenFile({ name: node.name, path: node.relativePath, type: "file", size: node.size });
  }

  function renderNodes(nodes, totalBytes) {
    const bounds = getBounds(elements.canvas);
    const width = bounds.width > 0 ? bounds.width : 1000;
    const height = bounds.height > 0 ? bounds.height : 600;
    const rectangles = layoutTreemap(nodes, width, height);
    elements.canvas.dataset.totalBytes = String(totalBytes);
    elements.canvas.replaceChildren(...rectangles.map(({ node, x, y, width: itemWidth, height: itemHeight }, index) => {
      const button = document.createElement("button");
      button.className = `storage-node type-${node.typeGroup}`;
      button.dataset.storageNode = node.id;
      button.setAttribute("role", "treeitem");
      button.setAttribute("aria-label", `${node.name}, ${formatSize(node.size)}, ${node.kind}`);
      if (!node.openable) button.setAttribute("aria-disabled", "true");
      button.style.left = `${(x / width) * 100}%`;
      button.style.top = `${(y / height) * 100}%`;
      button.style.width = `${(itemWidth / width) * 100}%`;
      button.style.height = `${(itemHeight / height) * 100}%`;
      button.tabIndex = index === 0 ? 0 : -1;
      const label = document.createElement("span");
      label.textContent = itemWidth >= 44 && itemHeight >= 24 ? `${node.name}\n${formatSize(node.size)}` : "";
      button.append(label);
      button.addEventListener("focus", () => showDetails(node));
      button.addEventListener("click", () => activateNode(node));
      button.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          button.click();
          return;
        }
        if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(event.key)) return;
        const items = [...elements.canvas.querySelectorAll("[data-storage-node]")];
        const current = items.indexOf(button);
        const next = event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : Math.max(0, Math.min(items.length - 1, current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1)));
        if (next !== current) {
          event.preventDefault();
          button.tabIndex = -1;
          items[next].tabIndex = 0;
          items[next].focus();
        }
      });
      return button;
    }));
  }

  function renderResult(result) {
    currentPath = result.requestedPath;
    renderBreadcrumbs(currentPath);
    elements.summary.textContent = `${formatSize(result.totalBytes)} · ${result.totalFiles} files · ${result.totalDirectories} folders`;
    elements.age.textContent = `Scanned ${new Date(result.completedAt).toLocaleTimeString()}`;
    renderLegend(result.root.children);
    renderNodes(result.root.children, result.totalBytes);
    elements.cancel.hidden = true;
    if (result.incomplete) setStatus(`Incomplete · ${reasonLabel(result.incompleteReason)}`, true);
    else if (result.excludedPaths?.length > 0) setStatus(`Scan complete · virtual filesystems excluded: /${result.excludedPaths.join(", /")}`);
    else if (result.warnings.length > 0) setStatus(`Complete with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`);
    else setStatus("Scan complete");
  }

  async function loadResult(path = "") {
    const response = await operations.storageScanResult(jobId, path);
    renderResult(response.result);
  }

  function schedulePoll() {
    clearPoll();
    pollTimer = setTimeout(() => void poll(), Math.max(10, pollDelay));
  }

  async function applyJob(job) {
    jobId = job.id;
    if (job.status === "running") {
      elements.cancel.hidden = false;
      setStatus(`Scanning · ${job.progress.files} files · ${formatSize(job.progress.bytes)}`);
      schedulePoll();
      return;
    }
    elements.cancel.hidden = true;
    if (job.resultAvailable) {
      await loadResult(currentPath);
      return;
    }
    if (job.status === "failed") setStatus(job.error?.message ?? "Storage scan failed", true);
    else setStatus(job.status === "cancelled" ? "Scan cancelled" : "Storage scan unavailable", true);
  }

  async function poll() {
    try {
      const response = await operations.storageScanStatus(jobId);
      await applyJob(response.job);
    } catch (error) {
      setStatus(`${error.message}. Retry the scan.`, true);
      elements.cancel.hidden = true;
    }
  }

  async function start(refresh) {
    clearPoll();
    currentPath = scanPath;
    elements.canvas.replaceChildren();
    elements.details.hidden = true;
    setStatus("Starting storage scan…");
    try {
      const response = await operations.startStorageScan(selectedRoot, scanPath, refresh);
      await applyJob(response.job);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  async function open(root, path = "") {
    selectedRoot = root;
    scanPath = path;
    currentPath = path;
    isOpen = true;
    elements.view.hidden = false;
    elements.close.focus();
    await start(false);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    clearPoll();
    elements.view.hidden = true;
    onClose();
  }

  async function refresh() {
    await start(true);
  }

  async function cancel() {
    if (!jobId) return;
    await operations.cancelStorageScan(jobId);
    clearPoll();
    elements.cancel.hidden = true;
    setStatus("Cancellation requested");
  }

  async function drill(path) {
    if (!jobId) return;
    try {
      await loadResult(path);
    } catch (error) {
      setStatus(error.message, true);
    }
  }

  elements.close.addEventListener("click", close);
  elements.refresh.addEventListener("click", () => void refresh());
  elements.cancel.addEventListener("click", () => void cancel());
  elements.up.addEventListener("click", () => {
    const parent = parentPath(currentPath);
    void drill(parent.length < scanPath.length ? scanPath : parent);
  });
  elements.root.addEventListener("click", () => void drill(scanPath));

  return { open, close, refresh, cancel, drill };
}
