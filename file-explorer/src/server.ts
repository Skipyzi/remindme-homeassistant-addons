import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { DomainError } from "./errors.js";
import { FilesystemService } from "./filesystem.js";
import { HostVaultService } from "./hostVaultService.js";
import { HostVaultStore } from "./hostVaultStore.js";
import { HostVaultError } from "./hostVaultTypes.js";
import { createHostRequestGuard } from "./hostRequestGuard.js";
import { PathPolicy } from "./pathPolicy.js";
import { createRootRegistry } from "./roots.js";
import { createBrowseRouter, type BrowseContext } from "./routes/browse.js";
import { createFilesRouter, type FileContext } from "./routes/files.js";
import { createHostVaultRouter, type HostVaultContext } from "./routes/hostVault.js";
import { createTrashRouter } from "./routes/trash.js";
import { createSearchRouter, type SearchContext } from "./routes/search.js";
import { createStorageMapRouter, type StorageMapContext } from "./routes/storageMap.js";
import { SafetyService } from "./safety.js";
import { SearchService } from "./search.js";
import { StorageScanner } from "./storageScanner.js";
import { StorageScanService } from "./storageScanService.js";
import { SshfsMountAdapter } from "./sshfsMount.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export type AppContext = BrowseContext & Partial<Pick<FileContext, "safety"> & Pick<SearchContext, "search"> & StorageMapContext & HostVaultContext>;

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
    if (options.context.hostVault) {
      app.use("/api", createHostRequestGuard(options.context.hostVault));
      app.use("/api", createHostVaultRouter(options.context as BrowseContext & HostVaultContext));
    }
    app.use("/api", createBrowseRouter(options.context));
    if (options.context.safety) {
      const fileContext = options.context as FileContext;
      app.use("/api", createFilesRouter(fileContext));
      app.use("/api", createTrashRouter(fileContext));
    }
    if (options.context.search) app.use("/api", createSearchRouter(options.context as SearchContext));
    if (options.context.storageScans) app.use("/api", createStorageMapRouter(options.context as StorageMapContext));
  }
  app.use(express.static(publicDir, { index: "index.html", fallthrough: false }));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof HostVaultError) {
      const statuses: Record<string, number> = {
        INVALID_VAULT_CONFIG: 500,
        INVALID_VAULT_PASSPHRASE: 401,
        INVALID_VAULT_SETUP: 400,
        VAULT_LOCKED_OUT: 429,
        VAULT_NOT_CONFIGURED: 409,
        VAULT_SESSION_INVALID: 401,
        FUSE_UNAVAILABLE: 503,
        HOST_KEY_MISMATCH: 409,
        SSH_UNAVAILABLE: 503,
        HOST_MOUNT_FAILED: 503,
      };
      response.status(statuses[error.code] ?? 500).json({ error: { code: error.code, message: error.message } });
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
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(backupDir, { recursive: true }), mkdir(trashDir, { recursive: true })]);
  const roots = createRootRegistry(config, { hostPath: "/host" });
  const policy = new PathPolicy(roots, [backupDir, trashDir]);
  const safety = new SafetyService(backupDir, trashDir);
  const storageScans = new StorageScanService(policy, new StorageScanner(), config.storageScan);
  const hostVault = new HostVaultService({
    store: new HostVaultStore(path.join(dataDir, "host-vault.json")),
    mount: new SshfsMountAdapter(),
    runtimeDirectory: "/run/file-explorer-host",
    mountPath: "/host",
  });
  hostVault.onLock(() => storageScans.invalidate("host"));
  await safety.purgeExpired(config.retentionDays);
  const retentionTimer = setInterval(() => {
    safety.purgeExpired(config.retentionDays).catch((error: unknown) => console.error("Retention cleanup failed", error));
  }, 86_400_000);
  retentionTimer.unref();
  const app = createApp({
    context: {
      config,
      roots,
      policy,
      filesystem: new FilesystemService(),
      safety,
      search: new SearchService(config),
      storageScans,
      hostVault,
    },
  });
  app.locals.dispose = async () => {
    clearInterval(retentionTimer);
    storageScans.dispose();
    await hostVault.dispose();
  };
  return app;
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 8091);
  createConfiguredApp()
    .then((app) => {
      const server = app.listen(port, "0.0.0.0", () => console.log(`file-explorer listening on ${port}`));
      const shutdown = () => {
        server.close();
        Promise.resolve(app.locals.dispose?.()).catch(() => undefined);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
      return server;
    })
    .catch((error: unknown) => {
      console.error("Unable to start file-explorer", error);
      process.exitCode = 1;
    });
}
