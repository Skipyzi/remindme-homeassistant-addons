import { randomUUID } from "node:crypto";
import { DomainError, StorageScanFatalError } from "./errors.js";
import { HostVaultError } from "./hostVaultTypes.js";
import type { PathPolicy } from "./pathPolicy.js";
import { projectStorageResult } from "./storageProjection.js";
import type { StorageScanner } from "./storageScanner.js";
import type { StorageJobSnapshot, StorageMapResult, StorageScanProgress, StorageScanTree } from "./storageTypes.js";
import type { AuthorizedPath, StorageScanLimits } from "./types.js";

interface StoragePathPolicy {
  authorize(rootId: string, rawPath: string, intent: "read"): Promise<AuthorizedPath>;
}

interface StorageScannerLike {
  scan(
    target: AuthorizedPath,
    limits: StorageScanLimits,
    signal: AbortSignal,
    onProgress: (progress: StorageScanProgress) => void,
    options?: { excludedRelativePaths?: readonly string[] },
  ): Promise<StorageScanTree>;
}

interface ServiceOptions {
  now?: () => number;
  idFactory?: () => string;
  logger?: Pick<Console, "error">;
  hostLimits?: StorageScanLimits;
}

interface InternalJob {
  snapshot: StorageJobSnapshot;
  generation: number;
  controller: AbortController;
  tree: StorageScanTree | null;
  expiresAt: number;
  lastAccessedAt: number;
  cacheKey: string;
  scanPath: string;
  ownerSession: string | undefined;
  limits: StorageScanLimits;
}

const HOST_EXCLUSIONS = ["proc", "sys", "dev", "run"] as const;

export class StorageScanService {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly activeByKey = new Map<string, string>();
  private readonly cacheByKey = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly logger: Pick<Console, "error">;
  private readonly hostLimits: StorageScanLimits;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly policy: StoragePathPolicy | Pick<PathPolicy, "authorize">,
    private readonly scanner: StorageScannerLike | Pick<StorageScanner, "scan">,
    private readonly limits: StorageScanLimits,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.logger = options.logger ?? console;
    this.hostLimits = options.hostLimits ?? limits;
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(5_000, Math.min(limits.cacheTtlMs, this.hostLimits.cacheTtlMs)));
    this.cleanupTimer.unref();
  }

  async start(rootId: string, refresh: boolean): Promise<StorageJobSnapshot>;
  async start(rootId: string, path: string, refresh: boolean, ownerSession?: string): Promise<StorageJobSnapshot>;
  async start(
    rootId: string,
    pathOrRefresh: string | boolean,
    refreshOrUndefined?: boolean,
    ownerSession?: string,
  ): Promise<StorageJobSnapshot> {
    const rawPath = typeof pathOrRefresh === "string" ? pathOrRefresh : "";
    const refresh = typeof pathOrRefresh === "boolean" ? pathOrRefresh : refreshOrUndefined === true;
    if (rootId === "host" && !ownerSession) throw new HostVaultError("VAULT_SESSION_INVALID", "Vault session is invalid");
    const target = await this.policy.authorize(rootId, rawPath, "read");
    if (refresh) this.invalidate(rootId);
    this.cleanup();
    const generation = this.generations.get(rootId) ?? 0;
    const cacheKey = `${rootId}\0${target.relativePath}`;
    const selectedLimits = rootId === "host" ? this.hostLimits : this.limits;

    const cachedId = this.cacheByKey.get(cacheKey);
    if (cachedId) {
      const cached = this.jobs.get(cachedId);
      if (cached && cached.generation === generation && cached.expiresAt > this.now() && cached.ownerSession === ownerSession) {
        cached.lastAccessedAt = this.now();
        return this.copySnapshot(cached.snapshot, true);
      }
      this.cacheByKey.delete(cacheKey);
    }

    const activeId = this.activeByKey.get(cacheKey);
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && active.generation === generation && active.snapshot.status === "running" && active.ownerSession === ownerSession) {
        return this.copySnapshot(active.snapshot);
      }
    }

    const id = this.idFactory();
    const controller = new AbortController();
    const snapshot: StorageJobSnapshot = {
      id,
      root: rootId,
      scanPath: target.relativePath,
      status: "running",
      progress: { files: 0, directories: 0, bytes: 0, currentPath: target.relativePath, elapsedMs: 0 },
      warnings: [],
      truncated: false,
      truncationReason: null,
      cached: false,
      completedAt: null,
      error: null,
      resultAvailable: false,
    };
    const job: InternalJob = {
      snapshot,
      generation,
      controller,
      tree: null,
      expiresAt: Number.POSITIVE_INFINITY,
      lastAccessedAt: this.now(),
      cacheKey,
      scanPath: target.relativePath,
      ownerSession,
      limits: selectedLimits,
    };
    this.jobs.set(id, job);
    this.activeByKey.set(cacheKey, id);

    void this.scanner.scan(
      target,
      selectedLimits,
      controller.signal,
      (progress) => { snapshot.progress = { ...progress }; },
      rootId === "host" ? { excludedRelativePaths: HOST_EXCLUSIONS } : undefined,
    ).then((tree) => {
      job.tree = tree;
      snapshot.progress = { ...tree.progress };
      snapshot.warnings = [...tree.warnings];
      snapshot.truncationReason = tree.stopReason;
      snapshot.truncated = tree.stopReason !== null;
      snapshot.completedAt = tree.completedAt;
      snapshot.resultAvailable = true;
      snapshot.status = tree.stopReason === "cancelled" ? "cancelled" : tree.stopReason === null ? "complete" : "partial";
      job.expiresAt = this.now() + selectedLimits.cacheTtlMs;
      job.lastAccessedAt = this.now();
      if (this.activeByKey.get(cacheKey) === id) this.activeByKey.delete(cacheKey);
      if ((snapshot.status === "complete" || snapshot.status === "partial") && (this.generations.get(rootId) ?? 0) === generation) {
        this.cacheByKey.set(cacheKey, id);
        this.evictCaches();
      }
    }, (error: unknown) => {
      const safeError = error instanceof StorageScanFatalError
        ? { code: error.code, message: error.message }
        : { code: "SCAN_FAILED", message: "Storage scan failed" };
      snapshot.status = "failed";
      snapshot.error = safeError;
      snapshot.completedAt = new Date().toISOString();
      job.expiresAt = this.now() + selectedLimits.cacheTtlMs;
      this.logger.error("Storage scan failed", { scanId: id, root: rootId, code: safeError.code });
      if (this.activeByKey.get(cacheKey) === id) this.activeByKey.delete(cacheKey);
    });

    return this.copySnapshot(snapshot);
  }

  snapshot(jobId: string, ownerSession?: string): StorageJobSnapshot {
    const job = this.requireJob(jobId, ownerSession);
    job.lastAccessedAt = this.now();
    return this.copySnapshot(job.snapshot);
  }

  async result(jobId: string, relativePath?: string, ownerSession?: string): Promise<StorageMapResult> {
    const job = this.requireJob(jobId, ownerSession);
    if (!job.tree || !job.snapshot.resultAvailable) {
      throw new DomainError("SCAN_NOT_READY", 409, "Storage scan result is not ready");
    }
    const requestedPath = relativePath === undefined ? job.scanPath : relativePath;
    const authorized = await this.policy.authorize(job.snapshot.root, requestedPath, "read");
    job.lastAccessedAt = this.now();
    return projectStorageResult(job.tree, authorized.relativePath, job.limits.maxResultNodes, jobId);
  }

  cancel(jobId: string, ownerSession?: string): void {
    const job = this.requireJob(jobId, ownerSession);
    if (job.snapshot.status === "running") job.controller.abort();
  }

  invalidate(...rootIds: string[]): void {
    const invalidated = new Set(rootIds);
    for (const rootId of invalidated) this.generations.set(rootId, (this.generations.get(rootId) ?? 0) + 1);
    for (const [id, job] of this.jobs) {
      if (!invalidated.has(job.snapshot.root)) continue;
      if (job.snapshot.status === "running") job.controller.abort();
      if (this.cacheByKey.get(job.cacheKey) === id) {
        this.cacheByKey.delete(job.cacheKey);
        this.jobs.delete(id);
      }
      if (this.activeByKey.get(job.cacheKey) === id) this.activeByKey.delete(job.cacheKey);
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) if (job.snapshot.status === "running") job.controller.abort();
  }

  private requireJob(jobId: string, ownerSession?: string): InternalJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new DomainError("SCAN_JOB_EXPIRED", 404, "Storage scan expired");
    if (job.snapshot.root === "host" && (!ownerSession || ownerSession !== job.ownerSession)) {
      throw new HostVaultError("VAULT_SESSION_INVALID", "Vault session is invalid");
    }
    return job;
  }

  private copySnapshot(snapshot: StorageJobSnapshot, cached = snapshot.cached): StorageJobSnapshot {
    return {
      ...snapshot,
      cached,
      progress: { ...snapshot.progress },
      warnings: snapshot.warnings.map((warning) => ({ ...warning })),
      error: snapshot.error ? { ...snapshot.error } : null,
    };
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (job.snapshot.status !== "running" && job.expiresAt <= now) {
        this.jobs.delete(id);
        if (this.cacheByKey.get(job.cacheKey) === id) this.cacheByKey.delete(job.cacheKey);
      }
    }
  }

  private evictCaches(): void {
    const cachedJobs = [...this.cacheByKey.entries()]
      .map(([cacheKey, id]) => ({ cacheKey, id, job: this.jobs.get(id) }))
      .filter((item): item is { cacheKey: string; id: string; job: InternalJob } => Boolean(item.job))
      .sort((left, right) => left.job.lastAccessedAt - right.job.lastAccessedAt);
    let estimatedNodes = cachedJobs.reduce((sum, item) => sum + (item.job.tree?.progress.files ?? 0) + (item.job.tree?.progress.directories ?? 0), 0);
    const maximumEntries = Math.max(this.limits.maxEntries, this.hostLimits.maxEntries);
    while (cachedJobs.length > 3 || estimatedNodes > maximumEntries * 2) {
      const oldest = cachedJobs.shift();
      if (!oldest) break;
      estimatedNodes -= (oldest.job.tree?.progress.files ?? 0) + (oldest.job.tree?.progress.directories ?? 0);
      this.cacheByKey.delete(oldest.cacheKey);
      this.jobs.delete(oldest.id);
    }
  }
}
