import { Router } from "express";
import { DomainError } from "../errors.js";
import type { HostVaultService } from "../hostVaultService.js";
import type { StorageJobSnapshot } from "../storageTypes.js";
import type { StorageScanService } from "../storageScanService.js";

export interface StorageMapContext {
  storageScans: StorageScanService;
  hostVault?: Pick<HostVaultService, "authorize">;
}

export function createStorageMapRouter(context: StorageMapContext): Router {
  const router = Router();

  function jobForRequest(jobId: string, token: string | undefined): StorageJobSnapshot {
    const job = context.storageScans.snapshot(jobId, token);
    if (job.root === "host") context.hostVault?.authorize(token);
    return job;
  }

  router.post("/storage-map/scans", async (request, response) => {
    if (typeof request.body.root !== "string" || request.body.root.length === 0) {
      throw new DomainError("INVALID_REQUEST", 400, "Root is required");
    }
    if (request.body.refresh !== undefined && typeof request.body.refresh !== "boolean") {
      throw new DomainError("INVALID_REQUEST", 400, "Refresh must be a boolean");
    }
    if (request.body.path !== undefined && typeof request.body.path !== "string") {
      throw new DomainError("INVALID_REQUEST", 400, "Path must be a string");
    }
    const job = await context.storageScans.start(
      request.body.root,
      request.body.path ?? "",
      request.body.refresh === true,
      response.locals.hostVaultToken,
    );
    response.status(202).json({ job });
  });

  router.get("/storage-map/scans/:jobId", (request, response) => {
    response.json({ job: jobForRequest(request.params.jobId, request.get("X-File-Explorer-Vault")) });
  });

  router.get("/storage-map/scans/:jobId/result", async (request, response) => {
    const token = request.get("X-File-Explorer-Vault");
    jobForRequest(request.params.jobId, token);
    const relativePath = typeof request.query.path === "string" ? request.query.path : undefined;
    response.json({ result: await context.storageScans.result(request.params.jobId, relativePath, token) });
  });

  router.delete("/storage-map/scans/:jobId", (request, response) => {
    const token = request.get("X-File-Explorer-Vault");
    jobForRequest(request.params.jobId, token);
    context.storageScans.cancel(request.params.jobId, token);
    response.status(204).end();
  });

  return router;
}
