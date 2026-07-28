export function createEditorState(api) {
  return {
    root: null, path: null, content: "", original: "", signature: null, error: null,
    get dirty() { return this.content !== this.original; },
    async open(root, path, { force = false } = {}) {
      if (this.dirty && !force) throw Object.assign(new Error("Unsaved changes"), { code: "UNSAVED_CHANGES" });
      const file = await api.request(`api/text?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, { hostVault: root === "host" });
      Object.assign(this, { root, path, content: file.content, original: file.content, signature: file.signature, error: null });
      return file;
    },
    update(content) { this.content = content; },
    discard() { this.content = this.original; this.error = null; },
    async save() {
      try {
        const result = await api.request("api/text", {
          method: "PUT",
          body: JSON.stringify({ root: this.root, path: this.path, content: this.content, signature: this.signature }),
          hostVault: this.root === "host",
        });
        this.original = this.content;
        this.signature = result.entry.signature;
        this.error = null;
        return result;
      } catch (error) { this.error = error; throw error; }
    },
  };
}
