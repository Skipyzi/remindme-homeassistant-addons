export function createOperations(api) {
  const hostStorageJobs = new Set();

  function downloadUrl(root, path) {
    return `./api/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
  }

  async function hostBlobUrl(root, path) {
    const response = await api.request(`api/download?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { hostVault: true });
    return URL.createObjectURL(await response.blob());
  }

  return {
    hostVaultStatus() { return api.request("api/host-vault/status", { hostVault: true }); },
    setupHostVault(input) { return api.request("api/host-vault/setup", { method: "POST", body: JSON.stringify(input) }); },
    unlockHostVault(passphrase) { return api.request("api/host-vault/unlock", { method: "POST", body: JSON.stringify({ passphrase }) }); },
    lockHostVault() { return api.request("api/host-vault/lock", { method: "POST", hostVault: true }); },
    resetHostVault(confirmation) { return api.request("api/host-vault", { method: "DELETE", body: JSON.stringify({ confirmation }) }); },
    create(root, path, type) { return api.request("api/files", { method: "POST", body: JSON.stringify({ root, path, type }), hostVault: root === "host" }); },
    move(root, source, target, targetRoot = root) { return api.request("api/move", { method: "POST", body: JSON.stringify({ root, source, target, targetRoot }), hostVault: root === "host" || targetRoot === "host" }); },
    trash(root, path) { return api.request("api/files", { method: "DELETE", body: JSON.stringify({ root, path }), hostVault: root === "host" }); },
    listTrash() { return api.request("api/trash"); },
    restore(id, alternatePath) { return api.request(`api/trash/${encodeURIComponent(id)}/restore`, { method: "POST", body: JSON.stringify({ alternatePath }) }); },
    purge(id, confirmed) {
      if (!confirmed) return Promise.resolve({ cancelled: true });
      return api.request(`api/trash/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    search(root, path, query, signal) {
      return api.request(`api/search?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&q=${encodeURIComponent(query)}`, {
        signal,
        hostVault: root === "host",
      });
    },
    async startStorageScan(root, path = "", refresh = false) {
      const result = await api.request("api/storage-map/scans", {
        method: "POST",
        body: JSON.stringify({ root, path, refresh }),
        hostVault: root === "host",
      });
      if (root === "host" && result?.job?.id) hostStorageJobs.add(result.job.id);
      return result;
    },
    storageScanStatus(id) {
      return api.request(`api/storage-map/scans/${encodeURIComponent(id)}`, { hostVault: hostStorageJobs.has(id) });
    },
    storageScanResult(id, path) {
      const suffix = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
      return api.request(`api/storage-map/scans/${encodeURIComponent(id)}/result${suffix}`, { hostVault: hostStorageJobs.has(id) });
    },
    cancelStorageScan(id) {
      return api.request(`api/storage-map/scans/${encodeURIComponent(id)}`, { method: "DELETE", hostVault: hostStorageJobs.has(id) });
    },
    upload(root, path, file) {
      return api.request(`api/upload?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file,
        hostVault: root === "host",
      });
    },
    downloadUrl,
    async download(root, path) {
      const link = document.createElement("a");
      let temporaryUrl = null;
      if (root === "host") {
        temporaryUrl = await hostBlobUrl(root, path);
        link.href = temporaryUrl;
      } else {
        link.href = downloadUrl(root, path);
      }
      link.download = path.split("/").filter(Boolean).at(-1) ?? "download";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      if (temporaryUrl) setTimeout(() => URL.revokeObjectURL(temporaryUrl), 0);
    },
    previewUrl(root, path) {
      return root === "host" ? hostBlobUrl(root, path) : Promise.resolve(downloadUrl(root, path));
    },
    revokePreview(url) {
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    },
  };
}
