import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("allows esbuild's required install script in the frozen Docker install", async () => {
  const [dockerfile, buildPolicy] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile("pnpm-workspace.yaml", "utf8").catch(() => ""),
  ]);

  expect(buildPolicy).toMatch(/^allowBuilds:\s*\n\s+esbuild:\s+true\s*$/m);
  expect(dockerfile).toContain("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./");
});

it("packages OpenSSH, SSHFS, and FUSE only in the runtime image", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  expect(dockerfile).toContain("RUN apk add --no-cache openssh-client sshfs fuse3");
  expect(dockerfile.indexOf("RUN apk add --no-cache")).toBeGreaterThan(dockerfile.lastIndexOf("FROM ${BUILD_FROM}"));
});

it("packages the documented Host Vault 0.3.0 release", async () => {
  const [config, readme] = await Promise.all([
    readFile("config.yaml", "utf8"),
    readFile("README.md", "utf8"),
  ]);

  expect(config).toContain('version: "0.3.0"');
  expect(config).toContain("host_scan_max_entries: 1000000");
  expect(config).toContain("host_scan_timeout_seconds: 600");
  expect(config).toContain("host_scan_cache_seconds: 300");
  expect(config).toContain("host_map_max_nodes: 10000");
  expect(config).toContain("type: homeassistant_config");
  expect(config).toContain("path: /config");
  expect(config).not.toMatch(/type:\s+config\b/);
  expect(config).toMatch(/privileged:\r?\n  - SYS_ADMIN/);
  expect(config).toMatch(/devices:\r?\n  - \/dev\/fuse/);
  expect(config).not.toContain("full_access: true");

  for (const phrase of [
    "port 22222",
    "dedicated SSH key",
    "host-key fingerprint",
    "Protection mode",
    "15 minutes",
    "read-only",
    "/proc",
    "logical file sizes",
    "hard links",
    "/mnt/data/supervisor/apps/data",
    "llama.cpp",
  ]) expect(readme).toContain(phrase);
});
