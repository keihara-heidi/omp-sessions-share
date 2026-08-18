import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { safeJoin, serveStatic } from "../daemon/static";

describe("safeJoin path traversal", () => {
  const root = resolve("/tmp/omp-web-root-test");

  test("allows nested paths under root", () => {
    expect(safeJoin(root, "/assets/app.js")).toBe(join(root, "assets/app.js"));
    expect(safeJoin(root, "/")).toBe(root);
  });

  test("rejects .. segments and encoded traversal", () => {
    expect(safeJoin(root, "/../secret")).toBeNull();
    expect(safeJoin(root, "/assets/../../etc/passwd")).toBeNull();
    expect(safeJoin(root, "/%2e%2e/secret")).toBeNull();
    expect(safeJoin(root, "/assets/%2e%2e/%2e%2e/etc/passwd")).toBeNull();
  });

  test("rejects null bytes, backslashes, and relative paths", () => {
    expect(safeJoin(root, "/foo\0bar")).toBeNull();
    expect(safeJoin(root, "/foo\\bar")).toBeNull();
    expect(safeJoin(root, "no-leading-slash")).toBeNull();
  });
});

describe("serveStatic", () => {
  test("serves files under web root and 404s traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-static-"));
    writeFileSync(join(dir, "index.html"), "<html>ok</html>");
    writeFileSync(join(dir, "app.js"), "console.log(1)");

    const index = await serveStatic(dir, "/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("ok");

    const asset = await serveStatic(dir, "/app.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");

    const traversal = await serveStatic(dir, "/../package.json");
    expect(traversal.status).toBe(404);
  });

  test("serves exported directory routes with or without a trailing slash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omp-static-route-"));
    for (const route of ["workspaces", "system"] as const) {
      mkdirSync(join(dir, route));
      writeFileSync(join(dir, route, "index.html"), `<html>${route}</html>`);

      for (const pathname of [`/${route}`, `/${route}/`]) {
        const response = await serveStatic(dir, pathname);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain(route);
      }
    }
  });
});
