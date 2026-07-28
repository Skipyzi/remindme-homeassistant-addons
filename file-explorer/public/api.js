export function createApi(
  fetcher = globalThis.fetch.bind(globalThis),
  { getVaultToken = () => globalThis.sessionStorage?.getItem("file-explorer-host-vault-token") } = {},
) {
  return {
    async request(relativePath, options = {}) {
      const { hostVault = false, ...requestOptions } = options;
      const headers = { ...(requestOptions.headers ?? {}) };
      if (typeof requestOptions.body === "string") headers["content-type"] = "application/json";
      const token = hostVault ? getVaultToken?.() : null;
      if (token) headers["X-File-Explorer-Vault"] = token;
      const response = await fetcher(`./${relativePath.replace(/^\/+/, "")}`, { ...requestOptions, headers });
      const isJson = response.headers.get("content-type")?.includes("application/json");
      const body = isJson ? await response.json() : response;
      if (!response.ok) {
        throw Object.assign(new Error(body?.error?.message ?? "Request failed"), body?.error ?? { code: "REQUEST_FAILED" });
      }
      return body;
    },
  };
}
