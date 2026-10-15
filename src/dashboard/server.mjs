import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AiOsError, asPublicError } from "../core/errors.mjs";

const ROOT = fileURLToPath(new URL("./", import.meta.url));
const PUBLIC = join(ROOT, "public");
const DIST = join(ROOT, "dist");
const FILES = new Map([
  ["/", [join(PUBLIC, "index.html"), "text/html; charset=utf-8"]],
  ["/index.html", [join(PUBLIC, "index.html"), "text/html; charset=utf-8"]],
  ["/styles.css", [join(PUBLIC, "styles.css"), "text/css; charset=utf-8"]],
  ["/dist/app.js", [join(DIST, "app.js"), "text/javascript; charset=utf-8"]],
]);

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function send(response, status, value, contentType = "application/json; charset=utf-8", headOnly = false, extra = {}) {
  const body = Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value);
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": contentType, "content-length": Buffer.byteLength(body), ...extra });
  response.end(headOnly ? undefined : body);
}

function localRequest(request, port) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = String(request.headers.host || "").toLowerCase();
  if (!allowedHosts.has(host)) throw new AiOsError("DASHBOARD_LOCAL_ONLY", "Dashboard accepts only loopback Host headers");
  if (!request.headers.origin) return;
  let origin;
  try {
    origin = new URL(request.headers.origin);
  } catch {
    throw new AiOsError("DASHBOARD_ORIGIN_DENIED", "Dashboard rejected an invalid Origin header");
  }
  if (origin.protocol !== "http:" || !allowedHosts.has(origin.host.toLowerCase())) {
    throw new AiOsError("DASHBOARD_ORIGIN_DENIED", "Dashboard rejected a cross-origin request");
  }
}

function statusFor(error) {
  if (["DASHBOARD_LOCAL_ONLY", "DASHBOARD_ORIGIN_DENIED", "PERMISSION_DENIED"].includes(error?.code)) return 403;
  return 500;
}

export async function createDashboardServer({ kernel, principalId = null, workspaceId = null, port = 4640 } = {}) {
  if (!kernel) throw new AiOsError("DASHBOARD_CONFIGURATION_INVALID", "Dashboard requires an AI OS kernel");
  const requestedPort = Number(port);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535 || (requestedPort > 0 && requestedPort < 1024)) {
    throw new AiOsError("DASHBOARD_CONFIGURATION_INVALID", "Dashboard port must be 0 for tests or between 1024 and 65535");
  }

  let actualPort = requestedPort;
  const server = createServer(async (request, response) => {
    try {
      localRequest(request, actualPort);
      const headOnly = request.method === "HEAD";
      if (request.method !== "GET" && !headOnly) {
        return send(response, 405, { ok: false, error: { code: "READ_ONLY", message: "Dashboard is read-only" } }, undefined, false, { allow: "GET, HEAD" });
      }
      const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      if (url.pathname === "/api/graph") {
        const projection = kernel.dashboardProjection({ principalId, workspaceId });
        return send(response, 200, { ok: true, data: projection }, undefined, headOnly);
      }
      if (url.pathname === "/api/health") {
        const projection = kernel.dashboardProjection({ principalId, workspaceId });
        return send(response, 200, {
          ok: true,
          data: { status: "READY", workspace_id: projection.workspace_id, read_only: true, projection: projection.schema },
        }, undefined, headOnly);
      }
      const asset = FILES.get(url.pathname);
      if (!asset) return send(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Resource not found" } }, undefined, headOnly);
      const [path, contentType] = asset;
      return send(response, 200, await readFile(path), contentType, headOnly);
    } catch (error) {
      const publicError = asPublicError(error);
      return send(response, statusFor(error), publicError);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  actualPort = server.address().port;
  const closed = new Promise((resolve) => server.once("close", resolve));
  return {
    host: "127.0.0.1",
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    read_only: true,
    closed,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
