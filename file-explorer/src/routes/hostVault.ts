import { Router } from "express";
import { DomainError } from "../errors.js";
import type { HostVaultService } from "../hostVaultService.js";
import { HostVaultError } from "../hostVaultTypes.js";

export interface HostVaultContext {
  hostVault: Pick<HostVaultService, "status" | "setup" | "unlock" | "lock" | "reset" | "authorize">;
}

function requiredString(value: unknown, name: string, maximumLength = 10_000): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) {
    throw new DomainError("INVALID_REQUEST", 400, `${name} is required`);
  }
  return value;
}

function vaultToken(header: string | undefined): string {
  if (!header) throw new HostVaultError("VAULT_SESSION_INVALID", "Vault session is invalid");
  return header;
}

export function createHostVaultRouter(context: HostVaultContext): Router {
  const router = Router();

  router.get("/host-vault/status", async (request, response) => {
    response.json(await context.hostVault.status(request.get("X-File-Explorer-Vault")));
  });

  router.post("/host-vault/setup", async (request, response) => {
    const port = request.body.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new DomainError("INVALID_REQUEST", 400, "Port must be between 1 and 65535");
    }
    await context.hostVault.setup({
      host: requiredString(request.body.host, "Host", 255),
      port,
      username: requiredString(request.body.username, "Username", 128),
      fingerprint: requiredString(request.body.fingerprint, "Fingerprint", 512),
      privateKey: requiredString(request.body.privateKey, "Private key", 1_500_000),
      passphrase: requiredString(request.body.passphrase, "Vault passphrase", 4_096),
      passphraseConfirmation: requiredString(request.body.passphraseConfirmation, "Vault passphrase confirmation", 4_096),
    });
    response.status(204).end();
  });

  router.post("/host-vault/unlock", async (request, response) => {
    try {
      response.json(await context.hostVault.unlock(requiredString(request.body.passphrase, "Vault passphrase", 4_096)));
    } catch (error) {
      if (error instanceof HostVaultError && error.code === "VAULT_LOCKED_OUT") {
        const status = await context.hostVault.status();
        response.setHeader("Retry-After", String(Math.max(1, Math.ceil(status.lockoutRemainingMs / 1_000))));
      }
      throw error;
    }
  });

  router.post("/host-vault/lock", async (request, response) => {
    await context.hostVault.lock(vaultToken(request.get("X-File-Explorer-Vault")));
    response.status(204).end();
  });

  router.delete("/host-vault", async (request, response) => {
    await context.hostVault.reset(requiredString(request.body.confirmation, "Confirmation", 64));
    response.status(204).end();
  });

  return router;
}
