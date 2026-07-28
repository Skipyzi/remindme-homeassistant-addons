export function createApi(fetcher = globalThis.fetch.bind(globalThis)) {
  return {
    async request(relativePath, options = {}) {
      const headers = { ...(options.headers ?? {}) };
      if (typeof options.body === "string") headers["content-type"] = "application/json";
      const response = await fetcher(`./${relativePath.replace(/^\/+/, "")}`, { ...options, headers });
      const isJson = response.headers.get("content-type")?.includes("application/json");
      const body = isJson ? await response.json() : response;
      if (!response.ok) {
        throw Object.assign(new Error(body?.error?.message ?? "Request failed"), body?.error ?? { code: "REQUEST_FAILED" });
      }
      return body;
    },
  };
}
