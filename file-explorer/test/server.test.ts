import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");

describe("server shell", () => {
  it("reports health", async () => {
    const response = await request(createApp({ publicDir })).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, service: "file-explorer" });
  });

  it("serves an ingress-relative application shell", async () => {
    const response = await request(createApp({ publicDir })).get("/");
    expect(response.status).toBe(200);
    expect(response.text).toContain('src="./app.js"');
    expect(response.text).toContain('href="./styles.css"');
    expect(response.text).toContain("data-up");
    expect(response.text).toContain("data-root-path");
    expect(response.text).toContain("data-breadcrumbs");
    expect(response.text).toContain("data-storage-open");
    expect(response.text).toContain("data-storage-map");
    expect(response.text).toContain("data-storage-close");
    expect(response.text).toContain("data-storage-refresh");
    expect(response.text).toContain("data-storage-cancel");
    expect(response.text).toContain("data-storage-canvas");
    expect(response.text).toContain("data-storage-details");
    expect(response.text).toContain("data-storage-status");
    expect(response.text).toContain("data-context-menu");
  });
});
