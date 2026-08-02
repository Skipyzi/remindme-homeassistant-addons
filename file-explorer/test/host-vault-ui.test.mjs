// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHostVaultController } from "../public/host-vault.js";

beforeEach(async () => {
  document.documentElement.innerHTML = await readFile(path.resolve("public/index.html"), "utf8");
  sessionStorage.clear();
});

function setup(status, overrides = {}) {
  let timerCallback = () => undefined;
  const operations = {
    hostVaultStatus: vi.fn(async () => status),
    setupHostVault: vi.fn(async () => undefined),
    unlockHostVault: vi.fn(async () => ({ token: "opaque-browser-token", expiresAt: "2026-07-28T10:15:00.000Z" })),
    lockHostVault: vi.fn(async () => undefined),
    resetHostVault: vi.fn(async () => undefined),
    ...overrides,
  };
  const onUnlocked = vi.fn();
  const onLocked = vi.fn();
  const controller = createHostVaultController({
    operations,
    onUnlocked,
    onLocked,
    now: () => Date.parse("2026-07-28T10:00:00.000Z"),
    setInterval: (callback) => { timerCallback = callback; return 1; },
    clearInterval: vi.fn(),
  });
  return { controller, operations, onUnlocked, onLocked, tick: () => timerCallback() };
}

describe("Host Vault UI", () => {
  it("shows first-time setup and clears every secret field after submission", async () => {
    const { controller, operations } = setup({
      configured: false, state: "unconfigured", connection: null, expiresAt: null, lockoutRemainingMs: 0, mountHealthy: false,
    });
    await controller.show();
    expect(document.querySelector("[data-host-vault]").hidden).toBe(false);
    expect(document.querySelector("[data-vault-setup]").hidden).toBe(false);

    const form = document.querySelector("[data-vault-setup-form]");
    form.elements.host.value = "172.30.32.1";
    form.elements.port.value = "22222";
    form.elements.username.value = "root";
    form.elements.fingerprint.value = "SHA256:ZmFrZS1maW5nZXJwcmludA";
    form.elements.privateKey.value = "-----BEGIN OPENSSH PRIVATE KEY-----\nUI PRIVATE MARKER\n-----END OPENSSH PRIVATE KEY-----";
    form.elements.passphrase.value = "vault ui phrase";
    form.elements.passphraseConfirmation.value = "vault ui phrase";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(operations.setupHostVault).toHaveBeenCalled());

    expect(form.elements.privateKey.value).toBe("");
    expect(form.elements.passphrase.value).toBe("");
    expect(form.elements.passphraseConfirmation.value).toBe("");
    expect(document.body.textContent).not.toContain("UI PRIVATE MARKER");
    controller.destroy();
  });

  it("unlocks into sessionStorage and notifies the explorer", async () => {
    const status = { configured: true, state: "locked", connection: { host: "172.30.32.1", port: 22222, username: "root", fingerprint: "SHA256:test" }, expiresAt: null, lockoutRemainingMs: 0, mountHealthy: false };
    const { controller, operations, onUnlocked } = setup(status);
    await controller.show();
    const form = document.querySelector("[data-vault-unlock-form]");
    form.elements.passphrase.value = "vault ui phrase";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(onUnlocked).toHaveBeenCalled());

    expect(operations.unlockHostVault).toHaveBeenCalledWith("vault ui phrase");
    expect(sessionStorage.getItem("file-explorer-host-vault-token")).toBe("opaque-browser-token");
    expect(form.elements.passphrase.value).toBe("");
    expect(document.querySelector("[data-host-vault]").hidden).toBe(true);
    controller.destroy();
  });

  it("locks manually, clears the token, and returns to the locked panel", async () => {
    sessionStorage.setItem("file-explorer-host-vault-token", "opaque-browser-token");
    const status = { configured: true, state: "unlocked", connection: null, expiresAt: "2026-07-28T10:15:00.000Z", lockoutRemainingMs: 0, mountHealthy: true };
    const { controller, operations, onLocked } = setup(status);
    await controller.refresh();

    document.querySelector("[data-host-lock]").click();
    await vi.waitFor(() => expect(onLocked).toHaveBeenCalled());

    expect(operations.lockHostVault).toHaveBeenCalled();
    expect(sessionStorage.getItem("file-explorer-host-vault-token")).toBeNull();
    controller.destroy();
  });

  it("shows a timed lockout and disables unlock", async () => {
    const { controller } = setup({
      configured: true, state: "locked", connection: null, expiresAt: null, lockoutRemainingMs: 31_000, mountHealthy: false,
    });
    await controller.show();

    expect(document.querySelector("[data-vault-unlock-form] button[type=submit]").disabled).toBe(true);
    expect(document.querySelector("[data-vault-status]").textContent).toContain("31 seconds");
    controller.destroy();
  });
});
