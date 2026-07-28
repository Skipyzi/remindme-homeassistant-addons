import { Router } from "express";
import { DomainError } from "../errors.js";
import type { StorageScanService } from "../storageScanService.js";

export interface StorageMapContext {
  storageScans: StorageScanService;
}

export function createStorageMapRouter(context: StorageMapContext): Router {
  const router = Router();

  router.post("/storage-map/scans", async (request, response) => {
    if (typeof request.body.root !== "string" || request.body.root.length === 0) {
      throw new DomainError("INVALID_REQUEST", 400, "Root is required");
    }
    if (request.body.refresh !== undefined && typeof request.body.refresh !== "boolean") {
      throw new DomainError("INVALID_REQUEST", 400, "Refresh must be a boolean");
    }
    const job = await context.storageScans.start(request.body.root, request.body.refresh === true);
    response.status(202).json({ job });
  });

  router.get("/storage-map/scans/:jobId", (request, response) => {
    response.json({ job: context.storageScans.snapshot(request.params.jobId) });
  });

  router.get("/storage-map/scans/:jobId/result", async (request, response) => {
    const relativePath = typeof request.query.path === "string" ? request.query.path : "";
    response.json({ result: await context.storageScans.result(request.params.jobId, relativePath) });
  });

  router.delete("/storage-map/scans/:jobId", (request, response) => {
    context.storageScans.cancel(request.params.jobId);
    response.status(204).end();
  });

  return router;
}
