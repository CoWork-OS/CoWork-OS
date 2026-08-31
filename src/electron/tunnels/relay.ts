import * as http from "http";
import { randomBytes, randomUUID } from "crypto";
import WebSocket, { WebSocketServer } from "ws";
import type { JSONRPCRequest, JSONRPCResponse } from "../mcp/types";
import { enforceTunnelPolicy, parseTunnelRelayMessage, validateJsonRpcRequest } from "./protocol";
import {
  DEFAULT_SECURE_MCP_TUNNEL_POLICY,
  SecureMcpTunnelPolicy,
  TunnelClientMessage,
} from "./types";

interface RelayTunnelRecord {
  id: string;
  name: string;
  clientToken: string;
  callerToken: string;
  createdAt: number;
  policy: SecureMcpTunnelPolicy;
}

interface RelaySession {
  tunnelId: string;
  ws: WebSocket;
  connectedAt: number;
  policy: SecureMcpTunnelPolicy;
  pending: Map<
    string,
    {
      resolve: (payload: JSONRPCResponse) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >;
}

const MAX_PENDING_REQUESTS_PER_TUNNEL = 32;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TunnelRelayServer {
  port: number;
  close: () => Promise<void>;
  records: Map<string, RelayTunnelRecord>;
  sessions: Map<string, RelaySession>;
}

export async function startTunnelRelayServer(
  options: {
    port?: number;
    host?: string;
    adminToken?: string;
    allowUnauthenticatedAdmin?: boolean;
  } = {},
): Promise<TunnelRelayServer> {
  const records = new Map<string, RelayTunnelRecord>();
  const sessions = new Map<string, RelaySession>();
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer(async (req, res) => {
    try {
      await handleHttpRequest(req, res, records, sessions, {
        adminToken: options.adminToken,
        allowUnauthenticatedAdmin: options.allowUnauthenticatedAdmin === true,
      });
    } catch (error: Any) {
      sendJson(res, error?.status || 500, { error: error?.message || "Internal error" });
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname !== "/v1/tunnels/connect") {
      socket.destroy();
      return;
    }
    const tunnelId = url.searchParams.get("tunnel_id") || "";
    const record = records.get(tunnelId);
    const token = readBearer(req.headers.authorization);
    if (!record || token !== record.clientToken) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const previous = sessions.get(tunnelId);
      previous?.ws.close(4000, "superseded");
      const session: RelaySession = {
        tunnelId,
        ws,
        connectedAt: Date.now(),
        policy: record.policy,
        pending: new Map(),
      };
      sessions.set(tunnelId, session);
      ws.on("message", (data) => handleClientMessage(session, data.toString()));
      ws.on("close", () => {
        if (sessions.get(tunnelId) === session) {
          sessions.delete(tunnelId);
        }
        for (const pending of session.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(new Error("Tunnel client disconnected"));
        }
        session.pending.clear();
      });
      ws.send(JSON.stringify({ type: "ready", tunnelId }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port || 8787;
  return {
    port,
    records,
    sessions,
    close: async () => {
      for (const session of sessions.values()) {
        session.ws.close(1001, "server closing");
      }
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  records: Map<string, RelayTunnelRecord>,
  sessions: Map<string, RelaySession>,
  auth: { adminToken?: string; allowUnauthenticatedAdmin: boolean },
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true, tunnels: records.size, connected: sessions.size });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/tunnels") {
    requireAdmin(req, auth);
    const body = await readJsonBody(req);
    const id =
      typeof body.id === "string" && body.id.trim() ? body.id.trim() : `tun_${randomUUID()}`;
    const record: RelayTunnelRecord = {
      id,
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : id,
      clientToken:
        typeof body.clientToken === "string" && body.clientToken.trim()
          ? body.clientToken.trim()
          : generateRelayToken("ctun"),
      callerToken:
        typeof body.callerToken === "string" && body.callerToken.trim()
          ? body.callerToken.trim()
          : generateRelayToken("ccall"),
      createdAt: Date.now(),
      policy: sanitizeRelayPolicy(body.policy),
    };
    records.set(record.id, record);
    sendJson(res, 201, record);
    return;
  }

  const statusMatch = url.pathname.match(/^\/v1\/tunnels\/([^/]+)\/status$/);
  if (req.method === "GET" && statusMatch) {
    const record = records.get(statusMatch[1]);
    if (!record) {
      sendJson(res, 404, { error: "Tunnel not found" });
      return;
    }
    if (!isStatusAuthorized(req, record, auth)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const session = sessions.get(record.id);
    sendJson(res, 200, {
      id: record.id,
      name: record.name,
      connected: Boolean(session),
      connectedAt: session?.connectedAt,
    });
    return;
  }

  const mcpMatch = url.pathname.match(/^\/v1\/tunnels\/([^/]+)\/mcp$/);
  if (req.method === "POST" && mcpMatch) {
    const tunnelId = mcpMatch[1];
    const record = records.get(tunnelId);
    if (!record) {
      sendJson(res, 404, { error: "Tunnel not found" });
      return;
    }
    if (readBearer(req.headers.authorization) !== record.callerToken) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const session = sessions.get(tunnelId);
    if (!session || session.ws.readyState !== WebSocket.OPEN) {
      sendJson(res, 503, { error: "Tunnel client is not connected" });
      return;
    }
    const payload = (await readJsonBody(req)) as JSONRPCRequest;
    validateJsonRpcRequest(payload);
    const bodyBytes = Buffer.byteLength(JSON.stringify(payload), "utf-8");
    const policyResult = enforceTunnelPolicy(session.policy, payload, bodyBytes);
    if (!policyResult.approved) {
      sendJson(res, 403, { error: policyResult.reason });
      return;
    }
    const response = await forwardToClient(
      session,
      payload,
      url.searchParams.get("caller") || undefined,
    );
    sendJson(res, response.error ? 502 : 200, response);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function handleClientMessage(session: RelaySession, raw: string): void {
  let message: TunnelClientMessage;
  try {
    message = JSON.parse(raw) as TunnelClientMessage;
  } catch {
    return;
  }
  if (message.type === "hello") {
    // Relay-side policy is authoritative. The client advertises its local policy
    // for diagnostics only and must not be able to relax relay enforcement.
    return;
  }
  if (message.type === "mcp_response") {
    const pending = session.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    session.pending.delete(message.requestId);
    pending.resolve(message.payload);
    return;
  }
  if (message.type === "mcp_error") {
    const pending = session.pending.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    session.pending.delete(message.requestId);
    pending.reject(new Error(message.error));
  }
}

function forwardToClient(
  session: RelaySession,
  payload: JSONRPCRequest,
  caller?: string,
): Promise<JSONRPCResponse> {
  if (session.pending.size >= MAX_PENDING_REQUESTS_PER_TUNNEL) {
    throw new HttpError(429, "Tunnel has too many pending requests");
  }
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pending.delete(requestId);
      reject(new Error("Tunnel request timed out"));
    }, session.policy.requestTimeoutMs);
    session.pending.set(requestId, { resolve, reject, timeout });
    const message = {
      type: "mcp_request",
      tunnelId: session.tunnelId,
      requestId,
      caller,
      deadlineMs: Date.now() + session.policy.requestTimeoutMs,
      payload,
    };
    parseTunnelRelayMessage(JSON.stringify(message));
    session.ws.send(JSON.stringify(message));
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > DEFAULT_SECURE_MCP_TUNNEL_POLICY.maxRequestBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}

function requireAdmin(
  req: http.IncomingMessage,
  auth: { adminToken?: string; allowUnauthenticatedAdmin: boolean },
): void {
  if (!auth.adminToken && auth.allowUnauthenticatedAdmin) return;
  if (!auth.adminToken) {
    throw new HttpError(401, "Tunnel relay admin token is required");
  }
  if (readBearer(req.headers.authorization) !== auth.adminToken) {
    throw new HttpError(401, "Unauthorized");
  }
}

function isStatusAuthorized(
  req: http.IncomingMessage,
  record: RelayTunnelRecord,
  auth: { adminToken?: string; allowUnauthenticatedAdmin: boolean },
): boolean {
  if (auth.allowUnauthenticatedAdmin && !auth.adminToken) return true;
  const token = readBearer(req.headers.authorization);
  return Boolean(token && (token === record.callerToken || token === auth.adminToken));
}

function readBearer(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = raw?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function generateRelayToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function sanitizeRelayPolicy(value: unknown): SecureMcpTunnelPolicy {
  const policy = isRecord(value) ? value : {};
  return {
    ...DEFAULT_SECURE_MCP_TUNNEL_POLICY,
    readOnly:
      typeof policy.readOnly === "boolean"
        ? policy.readOnly
        : DEFAULT_SECURE_MCP_TUNNEL_POLICY.readOnly,
    maxRequestBytes: clampInt(
      policy.maxRequestBytes,
      1024,
      10 * 1024 * 1024,
      DEFAULT_SECURE_MCP_TUNNEL_POLICY.maxRequestBytes,
    ),
    maxResponseBytes: clampInt(
      policy.maxResponseBytes,
      1024,
      25 * 1024 * 1024,
      DEFAULT_SECURE_MCP_TUNNEL_POLICY.maxResponseBytes,
    ),
    requestTimeoutMs: clampInt(
      policy.requestTimeoutMs,
      1000,
      300000,
      DEFAULT_SECURE_MCP_TUNNEL_POLICY.requestTimeoutMs,
    ),
    allowedTools: Array.isArray(policy.allowedTools)
      ? policy.allowedTools
          .map((tool) => (typeof tool === "string" ? tool.trim() : ""))
          .filter(Boolean)
      : [],
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, Any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

if (require.main === module) {
  const port = Number(process.env.COWORK_TUNNEL_RELAY_PORT || 8787);
  startTunnelRelayServer({
    port,
    host: process.env.COWORK_TUNNEL_RELAY_HOST || "127.0.0.1",
    adminToken: process.env.COWORK_TUNNEL_RELAY_ADMIN_TOKEN,
    allowUnauthenticatedAdmin: process.env.COWORK_TUNNEL_RELAY_ALLOW_DEV_ADMIN === "1",
  })
    .then((server) => {
      console.log(`CoWork secure MCP tunnel relay listening on http://127.0.0.1:${server.port}`);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
