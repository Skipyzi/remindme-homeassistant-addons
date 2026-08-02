import type { ExplorerConfig, RootDefinition } from "./types.js";

export function createRootRegistry(
  config: ExplorerConfig,
  options: { hostPath?: string } = {},
): ReadonlyMap<string, RootDefinition> {
  const roots = config.roots.filter((root) => root.enabled).map((root) => [root.id, root] as const);
  if (options.hostPath) {
    roots.push(["host", {
      id: "host",
      label: "Host /",
      absolutePath: options.hostPath,
      enabled: true,
      readOnly: true,
    }]);
  }
  return new Map(roots);
}
