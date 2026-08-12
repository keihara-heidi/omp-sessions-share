/** Safe static file serving for exported dashboard `web/` bundle. */

import { join, normalize, resolve, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  if (i <= 0) return "";
  return path.slice(i).toLowerCase();
}

/** Resolve web root: env override or sibling `web/` next to daemon. */
export function resolveWebRoot(fromDir = import.meta.dir): string {
  const fromEnv = process.env.OMP_SESSIONS_SHARE_WEB?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(fromDir, "web");
}

/**
 * Map URL pathname → file under webRoot.
 * Prevents path traversal; returns null when unsafe or outside root.
 */
export function safeJoin(webRoot: string, pathname: string): string | null {
  if (!pathname.startsWith("/")) return null;
  if (pathname.includes("\0")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const rel = decoded.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) return null;
  const root = resolve(webRoot);
  const candidate = normalize(join(root, rel));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

async function fileResponse(filePath: string): Promise<Response | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  const type = MIME[extOf(filePath)] ?? "application/octet-stream";
  return new Response(file, {
    headers: {
      "Content-Type": type,
      "Cache-Control":
        extOf(filePath) === ".html" ? "no-store" : "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * SPA + asset serving.
 * `/` → index.html; `/login` → login.html or login/index.html.
 */
export async function serveStatic(
  webRoot: string,
  pathname: string,
): Promise<Response> {
  if (pathname === "/" || pathname === "") {
    const index = await fileResponse(join(resolve(webRoot), "index.html"));
    if (index) return index;
    return new Response("dashboard not installed", { status: 503 });
  }

  if (pathname === "/login" || pathname === "/login/") {
    const root = resolve(webRoot);
    const loginHtml = await fileResponse(join(root, "login.html"));
    if (loginHtml) return loginHtml;
    const loginIndex = await fileResponse(join(root, "login", "index.html"));
    if (loginIndex) return loginIndex;
    return new Response("not found", { status: 404 });
  }

  const direct = safeJoin(webRoot, pathname);
  if (!direct) return new Response("not found", { status: 404 });

  const exact = await fileResponse(direct);
  if (exact) return exact;

  const asIndex = await fileResponse(join(direct, "index.html"));
  if (asIndex) return asIndex;

  if (!extOf(direct)) {
    const asHtml = await fileResponse(`${direct}.html`);
    if (asHtml) return asHtml;
  }

  return new Response("not found", { status: 404 });
}
