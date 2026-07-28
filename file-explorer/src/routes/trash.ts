import { Router } from "express";
import type { FileContext } from "./files.js";
import type { TrashRecord } from "../safety.js";

function publicRecord(record: TrashRecord) {
  return {
    id: record.id,
    rootId: record.rootId,
    originalPath: record.originalPath,
    entryType: record.entryType,
    deletedAt: record.deletedAt,
  };
}

export function createTrashRouter(context: FileContext): Router {
  const router = Router();

  router.delete("/files", async (request, response) => {
    const target = await context.policy.authorize(String(request.body.root ?? ""), String(request.body.path ?? ""), "write");
    response.json({ trash: publicRecord(await context.safety.trash(target)) });
  });

  router.get("/trash", async (_request, response) => {
    response.json({ items: (await context.safety.listTrash()).map(publicRecord) });
  });

  router.post("/trash/:id/restore", async (request, response) => {
    const record = await context.safety.readTrash(request.params.id);
    const destination = typeof request.body.alternatePath === "string" && request.body.alternatePath.length > 0
      ? request.body.alternatePath
      : record.originalPath;
    const target = await context.policy.authorize(record.rootId, destination, "create");
    await context.safety.restore(record.id, target);
    response.json({ entry: await context.filesystem.metadata(target) });
  });

  router.delete("/trash/:id", async (request, response) => {
    await context.safety.purge(request.params.id);
    response.status(204).end();
  });

  return router;
}
