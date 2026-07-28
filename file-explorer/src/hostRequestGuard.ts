import type { NextFunction, Request, Response } from "express";
import type { HostVaultService } from "./hostVaultService.js";

function requestRoots(request: Request): string[] {
  const values = [
    request.query.root,
    request.body?.root,
    request.body?.targetRoot,
  ];
  return values.filter((value): value is string => typeof value === "string");
}

export function createHostRequestGuard(hostVault: Pick<HostVaultService, "authorize">) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (!requestRoots(request).includes("host")) {
      next();
      return;
    }
    const token = request.get("X-File-Explorer-Vault");
    const session = hostVault.authorize(token);
    response.locals.hostVaultToken = session.token;
    next();
  };
}
