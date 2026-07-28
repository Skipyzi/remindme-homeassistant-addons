export const HOST_VAULT_TOKEN_KEY = "file-explorer-host-vault-token";

export function createHostVaultController({
  operations,
  onUnlocked,
  onLocked,
  now = Date.now,
  setInterval: schedule = globalThis.setInterval.bind(globalThis),
  clearInterval: unschedule = globalThis.clearInterval.bind(globalThis),
  prompt: ask = globalThis.prompt,
}) {
  const elements = {
    panel: document.querySelector("[data-host-vault]"),
    setup: document.querySelector("[data-vault-setup]"),
    setupForm: document.querySelector("[data-vault-setup-form]"),
    locked: document.querySelector("[data-vault-locked]"),
    unlockForm: document.querySelector("[data-vault-unlock-form]"),
    connection: document.querySelector("[data-vault-connection]"),
    status: document.querySelector("[data-vault-status]"),
    lock: document.querySelector("[data-host-lock]"),
    expiry: document.querySelector("[data-vault-expiry]"),
    reset: document.querySelector("[data-vault-reset]"),
  };
  let expiryAt = 0;
  let timer = null;

  function token() {
    return sessionStorage.getItem(HOST_VAULT_TOKEN_KEY);
  }

  function setMessage(message, error = false) {
    elements.status.textContent = message;
    elements.status.dataset.error = String(error);
  }

  function clearToken() {
    sessionStorage.removeItem(HOST_VAULT_TOKEN_KEY);
    expiryAt = 0;
    elements.lock.hidden = true;
    elements.expiry.hidden = true;
  }

  function renderCountdown() {
    if (!expiryAt) return;
    const remaining = Math.max(0, expiryAt - now());
    elements.expiry.textContent = `Host locks in ${Math.ceil(remaining / 60_000)} min`;
    elements.expiry.hidden = false;
    if (remaining === 0) {
      clearToken();
      elements.panel.hidden = false;
      void Promise.resolve(onLocked());
    }
  }

  function render(status) {
    const unlockedHere = status.state === "unlocked" && Boolean(token());
    elements.setup.hidden = status.configured;
    elements.locked.hidden = !status.configured || unlockedHere;
    elements.panel.hidden = unlockedHere;
    elements.lock.hidden = !unlockedHere;
    if (status.connection) {
      elements.connection.textContent = `${status.connection.username}@${status.connection.host}:${status.connection.port} · fingerprint pinned`;
    } else {
      elements.connection.textContent = "Debug SSH is not mounted.";
    }
    const submit = elements.unlockForm.querySelector('button[type="submit"]');
    submit.disabled = status.lockoutRemainingMs > 0;
    if (status.lockoutRemainingMs > 0) {
      setMessage(`Too many failed attempts. Try again in ${Math.ceil(status.lockoutRemainingMs / 1_000)} seconds.`, true);
    } else if (!status.configured) {
      setMessage("The private key will be encrypted before it is stored.");
    } else if (!unlockedHere) {
      setMessage("Unlocking mounts Host / read-only for this browser session.");
    } else {
      setMessage("Host / is mounted read-only.");
    }
    expiryAt = status.expiresAt ? Date.parse(status.expiresAt) : expiryAt;
    if (unlockedHere) renderCountdown();
  }

  async function refresh() {
    const status = await operations.hostVaultStatus();
    render(status);
    return status;
  }

  async function show() {
    elements.panel.hidden = false;
    try {
      return await refresh();
    } catch (error) {
      setMessage(error.message, true);
      throw error;
    }
  }

  elements.setupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = elements.setupForm;
    const input = {
      host: form.elements.host.value,
      port: Number(form.elements.port.value),
      username: form.elements.username.value,
      fingerprint: form.elements.fingerprint.value,
      privateKey: form.elements.privateKey.value,
      passphrase: form.elements.passphrase.value,
      passphraseConfirmation: form.elements.passphraseConfirmation.value,
    };
    form.elements.privateKey.value = "";
    form.elements.passphrase.value = "";
    form.elements.passphraseConfirmation.value = "";
    try {
      setMessage("Verifying the pinned host and read-only mount…");
      await operations.setupHostVault(input);
      setMessage("Host Vault created. Unlock it to browse Host /.");
      await refresh();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  elements.unlockForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const passphrase = elements.unlockForm.elements.passphrase.value;
    elements.unlockForm.elements.passphrase.value = "";
    try {
      setMessage("Unlocking and mounting Host / read-only…");
      const result = await operations.unlockHostVault(passphrase);
      sessionStorage.setItem(HOST_VAULT_TOKEN_KEY, result.token);
      expiryAt = Date.parse(result.expiresAt);
      elements.panel.hidden = true;
      elements.lock.hidden = false;
      renderCountdown();
      await onUnlocked();
    } catch (error) {
      setMessage(error.message, true);
      await refresh().catch(() => undefined);
    }
  });

  elements.lock.addEventListener("click", async () => {
    try {
      await operations.lockHostVault();
    } finally {
      clearToken();
      await onLocked();
    }
  });

  elements.reset.addEventListener("click", async () => {
    const confirmation = ask("Type RESET HOST VAULT to delete the encrypted vault configuration");
    if (confirmation !== "RESET HOST VAULT") return;
    try {
      await operations.resetHostVault(confirmation);
      clearToken();
      await show();
    } catch (error) {
      setMessage(error.message, true);
    }
  });

  timer = schedule(renderCountdown, 1_000);

  return {
    show,
    refresh,
    token,
    isUnlocked: () => Boolean(token()),
    hide: () => { elements.panel.hidden = true; },
    destroy: () => {
      if (timer !== null) unschedule(timer);
      clearToken();
    },
  };
}
