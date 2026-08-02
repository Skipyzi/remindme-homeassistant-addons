import { Router } from "express";
import { DomainError } from "../errors.js";
import type { BrowseContext } from "./browse.js";
import type { SearchService } from "../search.js";

export interface SearchContext extends BrowseContext {
  search: SearchService;
}

export function createSearchRouter(context: SearchContext): Router {
  const router = Router();
  router.get("/search", async (request, response) => {
    const query = typeof request.query.q === "string" ? request.query.q.trim() : "";
    if (!query) throw new DomainError("INVALID_REQUEST", 400, "Search query is required");
    const target = await context.policy.authorize(String(request.query.root ?? ""), String(request.query.path ?? ""), "read");
    const controller = new AbortController();
    request.once("aborted", () => controller.abort(new Error("Client disconnected")));
    response.json(await context.search.search({ target, query, signal: controller.signal }));
  });
  return router;
}
