export function createOperations(api) {
  return {
    create(root, path, type) { return api.request("api/files", { method: "POST", body: JSON.stringify({ root, path, type }) }); },
    move(root, source, target, targetRoot = root) { return api.request("api/move", { method: "POST", body: JSON.stringify({ root, source, target, targetRoot }) }); },
    trash(root, path) { return api.request("api/files", { method: "DELETE", body: JSON.stringify({ root, path }) }); },
    listTrash() { return api.request("api/trash"); },
    restore(id, alternatePath) { return api.request(`api/trash/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ alternatePath }) }); },
    purge(id, confirmed) {
      if (!confirmed) return Promise.resolve({ cancelled: true });
      return api.request(`api/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    search(root, path, query, signal) { return api.request(`api/search?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&q=${encodeURIComponent(query)}`, { signal }); },
    startStorageScan(root, refresh = false) {
      return api.request("api/storage-map/scans", {
        method: "POST",
        body: JSON.stringify({ root, refresh }),
      });
    },
    storageScanStatus(id) { return api.request(`api/storage-map/scans/${encodeURIComponent(id)}`); },
    storageScanResult(id, path = "") {
      return api.request(`api/storage-map/scans/${encodeURIComponent(id)}/result?path=${encodeURIComponent(path)}`);
    },
    cancelStorageScan(id) {
      return api.request(`api/storage-map/scans/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    async upload(root, path, file) {
      const response = await fetch(`./api/upload?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? "Upload failed"), body?.error);
      return body;
    },
    downloadUrl(root, path) { return `./api/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`; },
    download(root, path) {
      const link = document.createElement("a");
      link.href = this.downloadUrl(root, path);
      link.download = path.split("/").filter(Boolean).at(-1) ?? "download";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
    },
  };
}
