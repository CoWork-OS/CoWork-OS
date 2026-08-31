/**
 * Local HTTP ingest for debug-mode runtime logs (instrumented app/renderer/backend).
 * Ephemeral per-task sessions; logs are forwarded to the task timeline via callback.
 */

import * as http from "http";
import { randomBytes } from "crypto";
import { createLogger } from "../../utils/logger";

const log = createLogger("debug-runtime");

export type DebugIngestEntry = {
  taskId: string;
  line: string;
  rawBody: string;
  contentType: string;
  receivedAt: number;
};

type SessionRecord = {
  token: string;
  onIngest: (entry: DebugIngestEntry) => void;
};

const sessions = new Map<string, SessionRecord>();

let server: http.Server | null = null;
let listenPort = 0;

function getListenPort(): number {
  return listenPort;
}

export async function ensureDebugRuntimeServer(): Promise<number> {
  if (server && listenPort > 0) {
    return listenPort;
  }

  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      void handleRequest(req, res);
    });

    s.once("error", (err) => {
      log.error("debug runtime server error", err);
      reject(err);
    });

    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      listenPort = typeof addr === "object" && addr && "port" in addr ? Number(addr.port) : 0;
      server = s;
      log.info(`Debug runtime server listening on 127.0.0.1:${listenPort}`);
      resolve(listenPort);
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://127.0.0.1");

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  if (req.method !== "POST" || !url.pathname.includes("/cowork-debug/")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean);
  // /cowork-debug/<taskId>/ingest
  const ingestIdx = parts.indexOf("ingest");
  if (ingestIdx < 2 || parts[0] !== "cowork-debug") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("Bad path");
    return;
  }

  const taskId = decodeURIComponent(parts[ingestIdx - 1] || "");
  const token =
    url.searchParams.get("token") ||
    (typeof req.headers.authorization === "string" &&
    req.headers.authorization.startsWith("Bearer ")
      ? req.headers.authorization.slice("Bearer ".length).trim()
      : "");

  const session = sessions.get(taskId);
  if (!session || !token || session.token !== token) {
    res.writeHead(401, { "Content-Type": "text/plain" });
    res.end("Unauthorized");
    return;
  }

  const buf = await readBody(req);
  const contentType = String(req.headers["content-type"] || "");
  const rawBody = buf.toString("utf8");
  const line =
    contentType.includes("application/json") && rawBody.trim().startsWith("{")
      ? rawBody.slice(0, 8000)
      : rawBody.slice(0, 8000);

  session.onIngest({
    taskId,
    line,
    rawBody: rawBody.slice(0, 16_000),
    contentType,
    receivedAt: Date.now(),
  });

  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
  });
  res.end();
}

/**
 * Register a task session and return the full ingest URL for instrumented code.
 */
export async function openDebugRuntimeSession(
  taskId: string,
  onIngest: (entry: DebugIngestEntry) => void,
): Promise<{ baseUrl: string; token: string; ingestUrl: string }> {
  const port = await ensureDebugRuntimeServer();
  const token = randomBytes(24).toString("hex");
  sessions.set(taskId, { token, onIngest });
  const baseUrl = `http://127.0.0.1:${port}`;
  const ingestUrl = `${baseUrl}/cowork-debug/${encodeURIComponent(taskId)}/ingest?token=${encodeURIComponent(token)}`;
  return { baseUrl, token, ingestUrl };
}

export function closeDebugRuntimeSession(taskId: string): void {
  sessions.delete(taskId);
}

export function getDebugRuntimeListenPort(): number {
  return getListenPort();
}
