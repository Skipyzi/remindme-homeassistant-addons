import { randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import type { PathPolicy } from "./pathPolicy.js";
import { projectStorageResult } from "./storageProjection.js";
import type { StorageScanner } from "./storageScanner.js";
import type {
  StorageJobSnapshot,
  StorageMapResult,
  StorageScanProgress,
  StorageScanTree,
} from "./storageTypes.js";
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
  ): Promise<StorageScanTree>;
}

interface ServiceOptions {
  now?: () => number;
  idFactory?: () => string;
}

interface InternalJob {
  snapshot: StorageJobSnapshot;
  generation: number;
  controller: AbortController;
  tree: StorageScanTree | null;
  expiresAt: number;
  lastAccessedAt: number;
}

export class StorageScanService {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly activeByRoot = new Map<string, string>();
  private readonly cacheByRoot = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly policy: StoragePathPolicy | Pick<PathPolicy, "authorize">,
    private readonly scanner: StorageScannerLike | Pick<StorageScanner, "scan">,
    private readonly limits: StorageScanLimits,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.cleanupTimer = setInterval(() => this.cleanup(), Math.max(5_000, limits.cacheTtlMs));
    this.cleanupTimer.unref();
  }

  async start(rootId: string, refresh: boolean): Promise<StorageJobSnapshot> {
    const target = await this.policy.authorize(rootId, "", "read");
    if (refresh) this.invalidate(rootId);
    this.cleanup();
    const generation = this.generations.get(rootId) ?? 0;

    const cachedId = this.cacheByRoot.get(rootId);
    if (cachedId) {
      const cached = this.jobs.get(cachedId);
      if (cached && cached.generation === generation && cached.expiresAt > this.now()) {
        cached.lastAccessedAt = this.now();
        return this.copySnapshot(cached.snapshot, true);
      }
      this.cacheByRoot.delete(rootId);
    }

    const activeId = this.activeByRoot.get(rootId);
    if (activeId) {
      const active = this.jobs.get(activeId);
      if (active && active.generation === generation && active.snapshot.status === "running") {
        return this.copySnapshot(active.snapshot);
      }
    }

    const id = this.idFactory();
    const controller = new AbortController();
    const snapshot: StorageJobSnapshot = {
      id,
      root: rootId,
      status: "running",
      progress: { files: 0, directories: 0, bytes: 0, currentPath: "", elapsedMs: 0 },
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
    };
    this.jobs.set(id, job);
    this.activeByRoot.set(rootId, id);

    void this.scanner.scan(target, this.limits, controller.signal, (progress) => {
      snapshot.progress = { ...progress };
    }).then((tree) => {
      job.tree = tree;
      snapshot.progress = { ...tree.progress };
      snapshot.warnings = [...tree.warnings];
      snapshot.truncationReason = tree.stopReason;
      snapshot.truncated = tree.stopReason !== null;
      snapshot.completedAt = tree.completedAt;
      snapshot.resultAvailable = true;
      snapshot.status = tree.stopReason === "cancelled"
        ? "cancelled"
        : tree.stopReason === null ? "complete" : "partial";
      job.expiresAt = this.now() + this.limits.cacheTtlMs;
      job.lastAccessedAt = this.now();
      if (this.activeByRoot.get(rootId) === id) this.activeByRoot.delete(rootId);
      if (
        (snapshot.status === "complete" || snapshot.status === "partial")
        && (this.generations.get(rootId) ?? 0) === generation
      ) {
        this.cacheByRoot.set(rootId, id);
        this.evictCaches();
      }
    }, () => {
      snapshot.status = "failed";
      snapshot.error = { code: "SCAN_FAILED", message: "Storage scan failed" };
      snapshot.completedAt = new Date().toISOString();
      job.expiresAt = this.now() + this.limits.cacheTtlMs;
      if (this.activeByRoot.get(rootId) === id) this.activeByRoot.delete(rootId);
    });

    return this.copySnapshot(snapshot);
  }

  snapshot(jobId: string): StorageJobSnapshot {
    const job = this.requireJob(jobId);
    job.lastAccessedAt = this.now();
    return this.copySnapshot(job.snapshot);
  }

  async result(jobId: string, relativePath: string): Promise<StorageMapResult> {
    const job = this.requireJob(jobId);
    if (!job.tree || !job.snapshot.resultAvailable) {
      throw new DomainError("SCAN_NOT_READY", 409, "Storage scan result is not ready");
    }
    const authorized = await this.policy.authorize(job.snapshot.root, relativePath, "read");
    job.lastAccessedAt = this.now();
    return projectStorageResult(job.tree, authorized.relativePath, this.limits.maxResultNodes, jobId);
  }

  cancel(jobId: string): void {
    const job = this.requireJob(jobId);
    if (job.snapshot.status === "running") job.controller.abort();
  }

  invalidate(...rootIds: string[]): void {
    for (const rootId of new Set(rootIds)) {
      this.generations.set(rootId, (this.generations.get(rootId) ?? 0) + 1);
      const cachedId = this.cacheByRoot.get(rootId);
      if (cachedId) this.jobs.delete(cachedId);
      this.cacheByRoot.delete(rootId);
      const activeId = this.activeByRoot.get(rootId);
      if (activeId) this.jobs.get(activeId)?.controller.abort();
      this.activeByRoot.delete(rootId);
    }
  }

  dispose(): void {
    clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) {
      if (job.snapshot.status === "running") job.controller.abort();
    }
  }

  private requireJob(jobId: string): InternalJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new DomainError("SCAN_JOB_EXPIRED", 404, "Storage scan expired");
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
        if (this.cacheByRoot.get(job.snapshot.root) === id) this.cacheByRoot.delete(job.snapshot.root);
      }
    }
  }

  private evictCaches(): void {
    const cachedJobs = [...this.cacheByRoot.entries()]
      .map(([root, id]) => ({ root, id, job: this.jobs.get(id) }))
      .filter((item): item is { root: string; id: string; job: InternalJob } => Boolean(item.job))
      .sort((left, right) => left.job.lastAccessedAt - right.job.lastAccessedAt);
    let estimatedNodes = cachedJobs.reduce((sum, item) => sum + (item.job.tree?.progress.files ?? 0) + (item.job.tree?.progress.directories ?? 0), 0);
    while (cachedJobs.length > 3 || estimatedNodes > this.limits.maxEntries * 2) {
      const oldest = cachedJobs.shift();
      if (!oldest) break;
      estimatedNodes -= (oldest.job.tree?.progress.files ?? 0) + (oldest.job.tree?.progress.directories ?? 0);
      this.cacheByRoot.delete(oldest.root);
      this.jobs.delete(oldest.id);
    }
  }
}
