import path from "node:path";
import { writeFile } from "node:fs/promises";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemService } from "../src/filesystem.js";
import { PathPolicy } from "../src/pathPolicy.js";
import { createRootRegistry } from "../src/roots.js";
import { createApp } from "../src/server.js";
import { createFixtureRoots } from "./fixtures.js";

let fixture: Awaited<ReturnType<typeof createFixtureRoots>>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  fixture = await createFixtureRoots();
  const registry = createRootRegistry(fixture.config);
  app = createApp({
    context: {
      config: fixture.config,
      roots: registry,
      policy: new PathPolicy(registry, fixture.protectedPaths),
      filesystem: new FilesystemService(),
    },
  });
});

afterEach(async () => fixture.cleanup());

describe("browse API", () => {
  it("lists enabled roots without absolute paths", async () => {
    const response = await request(app).get("/api/roots");
    expect(response.status).toBe(200);
    expect(response.body.roots).toEqual([{ id: "config", label: "Config", readOnly: false }]);
    expect(JSON.stringify(response.body)).not.toContain(fixture.base);
  });

  it("lists directory entries without absolute paths", async () => {
    const response = await request(app).get("/api/entries").query({ root: "config", path: "automations" });
    expect(response.status).toBe(200);
    expect(response.body.entries[0]).toMatchObject({
      name: "morning.yaml",
      path: "automations/morning.yaml",
      type: "file",
    });
    expect(JSON.stringify(response.body)).not.toContain(fixture.base);
  });

  it("returns bounded text with a conflict signature", async () => {
    const response = await request(app).get("/api/text").query({ root: "config", path: "automations/morning.yaml" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ content: "alias: Morning\n", encoding: "utf-8" });
    expect(response.body.signature).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects binary and oversized text", async () => {
    await writeFile(path.join(fixture.configRoot, "binary.bin"), Buffer.from([0, 1, 2]));
    const binary = await request(app).get("/api/text").query({ root: "config", path: "binary.bin" });
    expect(binary.status).toBe(415);
    expect(binary.body.error.code).toBe("UNSUPPORTED_FILE");

    fixture.config.textEditMaxBytes = 2;
    const large = await request(app).get("/api/text").query({ root: "config", path: "automations/morning.yaml" });
    expect(large.status).toBe(413);
    expect(large.body.error.code).toBe("TOO_LARGE");
  });

  it("downloads regular files", async () => {
    const response = await request(app).get("/api/download").query({ root: "config", path: "automations/morning.yaml" });
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain("morning.yaml");
    expect(response.text).toBe("alias: Morning\n");
  });

  it("returns stable errors for traversal", async () => {
    const response = await request(app).get("/api/text").query({ root: "config", path: "../outside.txt" });
    expect(response.status).toBe(400);
    expect(response.body.error).toEqual({ code: "PATH_OUTSIDE_ROOT", message: "Path leaves its root" });
  });
});
