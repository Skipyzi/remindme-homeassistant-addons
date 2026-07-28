import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";
import { FilesystemService } from "./filesystem.js";
import { PathPolicy } from "./pathPolicy.js";
import { createRootRegistry } from "./roots.js";
import { createBrowseRouter, type BrowseContext } from "./routes/browse.js";
import { createFilesRouter, type FileContext } from "./routes/files.js";
import { createTrashRouter } from "./routes/trash.js";
import { createSearchRouter, type SearchContext } from "./routes/search.js";
import { SafetyService } from "./safety.js";
import { SearchService } from "./search.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type AppContext = BrowseContext & Partial<Pick<FileContext, "safety"> & Pick<SearchContext, "search">>;

export interface AppOptions {
  publicDir?: string;
  context?: AppContext;
}

export function createApp(options: AppOptions = {}): Express {
  const app = express();
  const publicDir = options.publicDir ?? path.resolve(moduleDir, "../public");

  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, service: "file-explorer" });
  });
  if (options.context) {
    app.use("/api", createBrowseRouter(options.context));
    if (options.context.safety) {
      const fileContext = options.context as FileContext;
      app.use("/api", createFilesRouter(fileContext));
      app.use("/api", createTrashRouter(fileContext));
    }
    if (options.context.search) app.use("/api", createSearchRouter(options.context as SearchContext));
  }
  app.use(express.static(publicDir, { index: "index.html", fallthrough: false }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
      ? error.status
      : 500;
    response.status(status).json({ error: { code: status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR", message: status === 404 ? "Not found" : "Request failed" } });
  });

  return app;
}

export async function createConfiguredApp(): Promise<Express> {
  const optionsPath = process.env.FILE_EXPLORER_OPTIONS ?? "/data/options.json";
  const dataDir = process.env.FILE_EXPLORER_DATA ?? "/data/file-explorer";
  const config = await loadConfig(optionsPath, dataDir);
  const backupDir = path.join(dataDir, "backups");
  const trashDir = path.join(dataDir, "trash");
  await Promise.all([mkdir(backupDir, { recursive: true }), mkdir(trashDir, { recursive: true })]);
  const roots = createRootRegistry(config);
  const safety = new SafetyService(backupDir, trashDir);
  await safety.purgeExpired(config.retentionDays);
  const retentionTimer = setInterval(() => {
    safety.purgeExpired(config.retentionDays).catch((error: unknown) => console.error("Retention cleanup failed", error));
  }, 86_400_000);
  retentionTimer.unref();
  return createApp({
    context: {
      config,
      roots,
      policy: new PathPolicy(roots, [backupDir, trashDir]),
      filesystem: new FilesystemService(),
      safety,
      search: new SearchService(config),
    },
  });
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 8091);
  createConfiguredApp()
    .then((app) => app.listen(port, "0.0.0.0", () => console.log(`file-explorer listening on ${port}`)))
    .catch((error: unknown) => {
      console.error("Unable to start file-explorer", error);
      process.exitCode = 1;
    });
}
