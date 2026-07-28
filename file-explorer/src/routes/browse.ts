import path from "node:path";
import { Router } from "express";
import type { FilesystemService } from "../filesystem.js";
import type { PathPolicy } from "../pathPolicy.js";
import type { ExplorerConfig, RootDefinition } from "../types.js";

export interface BrowseContext {
  config: ExplorerConfig;
  roots: ReadonlyMap<string, RootDefinition>;
  policy: PathPolicy;
  filesystem: FilesystemService;
}

function queryValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function createBrowseRouter(context: BrowseContext): Router {
  const router = Router();

  router.get("/roots", (_request, response) => {
    response.json({
      roots: [...context.roots.values()].map(({ id, label, readOnly }) => ({ id, label, readOnly })),
    });
  });

  router.get("/entries", async (request, response) => {
    const target = await context.policy.authorize(queryValue(request.query.root), queryValue(request.query.path), "read");
    response.json({ entries: await context.filesystem.list(target) });
  });

  router.get("/text", async (request, response) => {
    const target = await context.policy.authorize(queryValue(request.query.root), queryValue(request.query.path), "read");
    response.json(await context.filesystem.readText(target, context.config.textEditMaxBytes));
  });

  router.get("/download", async (request, response) => {
    const target = await context.policy.authorize(queryValue(request.query.root), queryValue(request.query.path), "read");
    response.attachment(path.basename(target.absolutePath));
    context.filesystem.download(target).pipe(response);
  });

  return router;
}
