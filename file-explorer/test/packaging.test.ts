import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("allows esbuild's required install script in the frozen Docker install", async () => {
  const [dockerfile, buildPolicy] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile("pnpm-workspace.yaml", "utf8").catch(() => ""),
  ]);

  expect(buildPolicy).toMatch(/^allowBuilds:\s*\n\s+esbuild:\s+true\s*$/m);
  expect(dockerfile).toContain(
    "COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./",
  );
});

it("packages the documented storage map release", async () => {
  const [config, readme] = await Promise.all([
    readFile("config.yaml", "utf8"),
    readFile("README.md", "utf8"),
  ]);

  expect(config).toContain('version: "0.2.0"');
  expect(config).toContain("storage_scan_max_entries: 200000");
  expect(config).toContain("storage_scan_timeout_seconds: 120");
  expect(config).toContain("storage_scan_cache_seconds: 60");
  expect(config).toContain("storage_map_max_nodes: 5000");
  expect(readme).toContain("Storage map");
  expect(readme).toContain("logical file sizes");
  expect(readme).toContain("does not follow symlinks");
});
