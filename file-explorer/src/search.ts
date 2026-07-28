import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AuthorizedPath, ExplorerConfig } from "./types.js";

export interface SearchResult {
  path: string;
  type: "file" | "directory";
  matchedBy: "name" | "content";
  excerpt?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  truncated: boolean;
  failures: Array<{ path: string; message: string }>;
}

const ignoredNames = new Set([".git", "node_modules"]);

export function safeSearchFailure(_error: unknown): string {
  return "Read failed";
}

export class SearchService {
  constructor(private readonly config: ExplorerConfig) {}

  async search(input: { target: AuthorizedPath; query: string; signal: AbortSignal }): Promise<SearchResponse> {
    const query = input.query.toLocaleLowerCase();
    const deadline = Date.now() + this.config.searchTimeoutMs;
    const queue = [input.target.absolutePath];
    const results: SearchResult[] = [];
    const failures: Array<{ path: string; message: string }> = [];
    let timedOut = false;

    while (queue.length > 0 && results.length < this.config.searchMaxResults) {
      if (input.signal.aborted) throw input.signal.reason ?? new Error("Search cancelled");
      if (Date.now() >= deadline) { timedOut = true; break; }
      const current = queue.shift()!;
      const relative = path.relative(input.target.absolutePath, current).split(path.sep).join("/");
      try {
        const details = await lstat(current);
        if (details.isSymbolicLink()) continue;
        const name = path.basename(current);
        if (relative && name.toLocaleLowerCase().includes(query)) {
          results.push({ path: path.posix.join(input.target.relativePath, relative), type: details.isDirectory() ? "directory" : "file", matchedBy: "name" });
          if (results.length >= this.config.searchMaxResults) break;
        }
        if (details.isDirectory()) {
          const children = await readdir(current);
          for (const child of children) if (!ignoredNames.has(child)) queue.push(path.join(current, child));
        } else if (details.isFile() && details.size <= this.config.searchFileMaxBytes) {
          const data = await readFile(current);
          if (data.includes(0)) continue;
          const content = data.toString("utf8");
          const index = content.toLocaleLowerCase().indexOf(query);
          if (index >= 0 && !name.toLocaleLowerCase().includes(query)) {
            const start = Math.max(0, index - 40);
            results.push({
              path: path.posix.join(input.target.relativePath, relative),
              type: "file",
              matchedBy: "content",
              excerpt: content.slice(start, Math.min(content.length, index + query.length + 80)).replaceAll("\n", " "),
            });
          }
        }
      } catch (error) {
        failures.push({ path: path.posix.join(input.target.relativePath, relative), message: safeSearchFailure(error) });
      }
    }

    return { results, truncated: timedOut || queue.length > 0, failures };
  }
}
