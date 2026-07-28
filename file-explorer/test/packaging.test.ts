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
