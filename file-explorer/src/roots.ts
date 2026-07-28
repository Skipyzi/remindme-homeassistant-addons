import type { ExplorerConfig, RootDefinition } from "./types.js";

export function createRootRegistry(config: ExplorerConfig): ReadonlyMap<string, RootDefinition> {
  return new Map(config.roots.filter((root) => root.enabled).map((root) => [root.id, root]));
}
