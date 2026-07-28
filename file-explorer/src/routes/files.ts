import { Router } from "express";
import type { BrowseContext } from "./browse.js";
import type { SafetyService } from "../safety.js";

export interface FileContext extends BrowseContext {
  safety: SafetyService;
  storageScans?: { invalidate(...rootIds: string[]): void };
}

export function createFilesRouter(context: FileContext): Router {
  const router = Router();

  router.post("/files", async (request, response) => {
    const target = await context.policy.authorize(String(request.body.root ?? ""), String(request.body.path ?? ""), "create");
    const entry = request.body.type === "directory"
      ? await context.filesystem.createDirectory(target)
      : await context.filesystem.createFile(target);
    context.storageScans?.invalidate(target.root.id);
    response.status(201).json({ entry });
  });

  router.put("/upload", async (request, response) => {
    const target = await context.policy.authorize(String(request.query.root ?? ""), String(request.query.path ?? ""), "create");
    const entry = await context.filesystem.receiveUpload(target, request, context.config.uploadMaxBytes);
    context.storageScans?.invalidate(target.root.id);
    response.status(201).json({ entry });
  });

  router.put("/text", async (request, response) => {
    const target = await context.policy.authorize(String(request.body.root ?? ""), String(request.body.path ?? ""), "write");
    const result = await context.filesystem.saveAtomic(
      target,
      String(request.body.content ?? ""),
      String(request.body.signature ?? ""),
      context.safety,
      context.config.textEditMaxBytes,
    );
    context.storageScans?.invalidate(target.root.id);
    response.json({ entry: result.metadata, backup: { id: result.backup.id, createdAt: result.backup.createdAt } });
  });

  router.post("/move", async (request, response) => {
    const root = String(request.body.root ?? "");
    const source = await context.policy.authorize(root, String(request.body.source ?? ""), "write");
    const target = await context.policy.authorize(String(request.body.targetRoot ?? root), String(request.body.target ?? ""), "create");
    const entry = await context.filesystem.move(source, target);
    context.storageScans?.invalidate(...new Set([source.root.id, target.root.id]));
    response.json({ entry });
  });

  return router;
}
