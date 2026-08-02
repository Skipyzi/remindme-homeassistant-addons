import path from "node:path";
import { realpath } from "node:fs/promises";
import { DomainError } from "./errors.js";
import type { AuthorizedPath, PathIntent, RootDefinition } from "./types.js";

function assertContained(rootReal: string, candidate: string): void {
  const relative = path.relative(rootReal, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new DomainError("PATH_OUTSIDE_ROOT", 400, "Path leaves its root");
  }
}

export class PathPolicy {
  constructor(
    private readonly roots: ReadonlyMap<string, RootDefinition>,
    private readonly protectedPaths: readonly string[],
  ) {}

  async authorize(rootId: string, rawPath: string, intent: PathIntent): Promise<AuthorizedPath> {
    const root = this.roots.get(rootId);
    if (!root) throw new DomainError("ROOT_DISABLED", 404, "Root is not enabled");
    if (intent !== "read" && root.readOnly) {
      throw new DomainError("READ_ONLY_ROOT", 403, "Root is read-only");
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPath.replaceAll("\\", "/"));
    } catch {
      throw new DomainError("PATH_OUTSIDE_ROOT", 400, "Path encoding is invalid");
    }
    if (decoded.startsWith("/") || /^[A-Za-z]:/.test(decoded)) {
      throw new DomainError("PATH_OUTSIDE_ROOT", 400, "Path must be relative");
    }

    const normalized = path.posix.normalize(decoded);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new DomainError("PATH_OUTSIDE_ROOT", 400, "Path leaves its root");
    }

    const rootReal = await realpath(root.absolutePath);
    const relativePath = normalized === "." ? "" : normalized;
    const absolutePath = path.resolve(rootReal, relativePath);
    assertContained(rootReal, absolutePath);

    if (intent === "create") {
      const parentReal = await realpath(path.dirname(absolutePath)).catch(() => {
        throw new DomainError("NOT_FOUND", 404, "Parent directory does not exist");
      });
      assertContained(rootReal, parentReal);
    } else {
      const targetReal = await realpath(absolutePath).catch(() => {
        throw new DomainError("NOT_FOUND", 404, "Path does not exist");
      });
      assertContained(rootReal, targetReal);
    }

    for (const protectedPath of this.protectedPaths) {
      if (absolutePath === protectedPath || absolutePath.startsWith(`${protectedPath}${path.sep}`)) {
        throw new DomainError("PATH_OUTSIDE_ROOT", 403, "Protected path is unavailable");
      }
    }

    return { root, relativePath, absolutePath };
  }
}
