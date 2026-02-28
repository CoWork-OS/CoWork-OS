/**
 * WebAccessServer — serves the CoWork OS renderer as a web app,
 * proxying IPC calls over HTTP/WebSocket with token authentication.
 *
 * This extends the existing ControlPlane infrastructure to provide
 * full browser-based access to the application.
 */

import * as http from "http";
import * as path from "path";
import * as fs from "fs";
import * as crypto from "crypto";
import { WebAccessConfig, WebAccessStatus, DEFAULT_WEB_ACCESS_CONFIG } from "./types";

interface WebAccessServerDeps {
  /** Handle an IPC-equivalent invoke from the web client */
  handleIpcInvoke: (channel: string, ...args: Any[]) => Promise<Any>;
  /** Get the path to the built renderer files */
  getRendererPath: () => string;
  /** Forward real-time events to connected WebSocket clients */
  onDaemonEvent?: (callback: (event: Any) => void) => void;
  log?: (...args: unknown[]) => void;
}

export class WebAccessServer {
  private server: http.Server | null = null;
  private wsClients: Set<Any> = new Set();
  private config: WebAccessConfig;
  private deps: WebAccessServerDeps;
  private startedAt?: number;

  constructor(config: Partial<WebAccessConfig>, deps: WebAccessServerDeps) {
    this.config = this.normalizeConfig(config);
    this.deps = deps;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    // WebSocket upgrade
    this.server.on("upgrade", (req, socket, head) => {
      this.handleWebSocketUpgrade(req, socket, head);
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.startedAt = Date.now();
        this.log(`[WebAccess] Server started at http://${this.config.host}:${this.config.port}`);
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    // Close all WebSocket connections
    for (const client of this.wsClients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    this.wsClients.clear();

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        this.startedAt = undefined;
        this.log("[WebAccess] Server stopped");
        resolve();
      });
    });
  }

  getStatus(): WebAccessStatus {
    return {
      running: !!this.server,
      url: this.server ? `http://${this.config.host}:${this.config.port}` : undefined,
      port: this.config.port,
      connectedClients: this.wsClients.size,
      startedAt: this.startedAt,
    };
  }

  getConfig(): WebAccessConfig {
    return { ...this.config };
  }

  /**
   * Apply configuration updates at runtime.
   * Restarts the HTTP server if host/port changes or when toggling enabled state.
   */
  async applyConfig(updates: Partial<WebAccessConfig>): Promise<WebAccessConfig> {
    const previousConfig = { ...this.config };
    const wasRunning = !!this.server;
    const nextConfig = this.normalizeConfig({ ...this.config, ...updates });
    const needsRestart =
      wasRunning &&
      (previousConfig.host !== nextConfig.host || previousConfig.port !== nextConfig.port);

    try {
      if (wasRunning && (needsRestart || !nextConfig.enabled)) {
        await this.stop();
      }

      this.config = nextConfig;

      if (nextConfig.enabled && (!wasRunning || needsRestart || !this.server)) {
        await this.start();
      }

      return this.getConfig();
    } catch (error) {
      this.config = previousConfig;
      if (wasRunning && !this.server) {
        try {
          await this.start();
        } catch (restartError) {
          this.log("[WebAccess] Failed to recover previous server state:", restartError);
        }
      }
      throw error;
    }
  }

  // ── HTTP handler ────────────────────────────────────────────────

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const requestOrigin =
      typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
    const corsOrigin = this.resolveCorsOrigin(requestOrigin);

    // CORS headers
    if (corsOrigin) {
      res.setHeader("Access-Control-Allow-Origin", corsOrigin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      if (requestOrigin && !corsOrigin) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Origin not allowed" }));
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check (no auth required)
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
      return;
    }

    // API routes require auth
    if (url.pathname.startsWith("/api/")) {
      if (!this.authenticate(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      await this.handleApiRoute(url, req, res);
      return;
    }

    // Serve static renderer files
    this.serveStatic(url.pathname, res);
  }

  private authenticate(req: http.IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth) return false;
    const token = auth.replace("Bearer ", "");
    if (!token || !this.config.token) return false;
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(this.config.token);
    if (tokenBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(tokenBuf, expectedBuf);
  }

  private async handleApiRoute(
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = req.method !== "GET" ? await readBody(req) : null;
      const params = body ? JSON.parse(body) : {};

      // Map REST routes to IPC channels
      let channel: string;
      let args: Any[];
      const includeSecrets =
        url.searchParams.get("includeSecrets") === "1" ||
        url.searchParams.get("includeSecrets")?.toLowerCase() === "true";

      if (url.pathname === "/api/tasks" && req.method === "GET") {
        channel = "task:list";
        args = [];
      } else if (url.pathname === "/api/tasks" && req.method === "POST") {
        channel = "task:create";
        args = [params];
      } else if (url.pathname.match(/^\/api\/tasks\/[^/]+$/) && req.method === "GET") {
        const taskId = url.pathname.split("/").pop()!;
        channel = "task:get";
        args = [taskId];
      } else if (url.pathname.match(/^\/api\/tasks\/[^/]+\/message$/) && req.method === "POST") {
        const taskId = url.pathname.split("/")[3];
        channel = "task:sendMessage";
        args = [{ taskId, ...params }];
      } else if (url.pathname.match(/^\/api\/tasks\/[^/]+\/events$/) && req.method === "GET") {
        const taskId = url.pathname.split("/")[3];
        channel = "task:events";
        args = [taskId];
      } else if (url.pathname === "/api/workspaces" && req.method === "GET") {
        channel = "workspace:list";
        args = [];
      } else if (url.pathname === "/api/accounts" && req.method === "GET") {
        channel = "account:list";
        args = [
          {
            provider: url.searchParams.get("provider") || undefined,
            status: url.searchParams.get("status") || undefined,
            includeSecrets,
          },
        ];
      } else if (url.pathname === "/api/accounts" && req.method === "POST") {
        channel = "account:upsert";
        args = [params];
      } else if (url.pathname.match(/^\/api\/accounts\/[^/]+$/) && req.method === "GET") {
        const accountId = url.pathname.split("/").pop()!;
        channel = "account:get";
        args = [{ accountId, includeSecrets }];
      } else if (url.pathname.match(/^\/api\/accounts\/[^/]+$/) && req.method === "PUT") {
        const accountId = url.pathname.split("/").pop()!;
        channel = "account:upsert";
        args = [{ ...params, id: accountId }];
      } else if (url.pathname.match(/^\/api\/accounts\/[^/]+$/) && req.method === "DELETE") {
        const accountId = url.pathname.split("/").pop()!;
        channel = "account:remove";
        args = [{ accountId }];
      } else if (url.pathname === "/api/briefing" && req.method === "POST") {
        channel = "briefing:generate";
        args = [params.workspaceId];
      } else if (url.pathname === "/api/suggestions" && req.method === "GET") {
        channel = "suggestions:list";
        args = [url.searchParams.get("workspaceId") || ""];
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      const result = await this.deps.handleIpcInvoke(channel, ...args);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Internal error" }));
    }
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    const rendererPath = path.resolve(this.deps.getRendererPath());
    const decodedPathname = this.decodePathname(pathname);
    if (decodedPathname === null) {
      res.writeHead(400);
      res.end("Bad request");
      return;
    }

    const requestedPath = decodedPathname === "/" ? "/index.html" : decodedPathname;
    let filePath = path.resolve(rendererPath, `.${requestedPath}`);
    if (!this.isPathWithinBase(filePath, rendererPath)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Fallback to index.html for SPA routing
    if (!fs.existsSync(filePath)) {
      filePath = path.join(rendererPath, "index.html");
    }

    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
    };

    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  }

  // ── WebSocket ───────────────────────────────────────────────────

  private handleWebSocketUpgrade(req: http.IncomingMessage, socket: Any, _head: Buffer): void {
    // Simplified WebSocket handling using raw socket
    // In production, use the `ws` package (already a dependency)
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);
      const token = url.searchParams.get("token");

      if (!token || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.config.token))) {
        socket.destroy();
        return;
      }

      // For full WebSocket support, wire up the existing `ws` package here
      // This is a placeholder for the upgrade handler
      this.log("[WebAccess] WebSocket upgrade requested — wire ws package for full support");
      socket.destroy();
    } catch {
      socket.destroy();
    }
  }

  private log(...args: unknown[]): void {
    if (this.deps.log) this.deps.log(...args);
    else console.log(...args);
  }

  private resolveCorsOrigin(requestOrigin: string): string | null {
    const allowed = this.config.allowedOrigins;
    if (allowed.includes("*")) return "*";
    if (!requestOrigin) return allowed[0] || null;
    return allowed.includes(requestOrigin) ? requestOrigin : null;
  }

  private normalizeConfig(config: Partial<WebAccessConfig>): WebAccessConfig {
    const merged = { ...DEFAULT_WEB_ACCESS_CONFIG, ...config };
    const normalized: WebAccessConfig = {
      enabled: merged.enabled === true,
      port: Number.isFinite(Number(merged.port))
        ? Math.min(65535, Math.max(1, Math.floor(Number(merged.port))))
        : DEFAULT_WEB_ACCESS_CONFIG.port,
      host:
        typeof merged.host === "string" && merged.host.trim().length > 0
          ? merged.host.trim()
          : DEFAULT_WEB_ACCESS_CONFIG.host,
      token: typeof merged.token === "string" ? merged.token.trim() : "",
      allowedOrigins: Array.isArray(merged.allowedOrigins)
        ? merged.allowedOrigins
            .filter((origin): origin is string => typeof origin === "string")
            .map((origin) => origin.trim())
            .filter(Boolean)
        : [...DEFAULT_WEB_ACCESS_CONFIG.allowedOrigins],
    };

    if (!normalized.token) {
      normalized.token = crypto.randomBytes(32).toString("hex");
    }
    if (normalized.allowedOrigins.length === 0) {
      normalized.allowedOrigins = [`http://${normalized.host}:${normalized.port}`];
    }
    return normalized;
  }

  private decodePathname(pathname: string): string | null {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return null;
    }
  }

  private isPathWithinBase(targetPath: string, basePath: string): boolean {
    const relative = path.relative(basePath, targetPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BODY = 1024 * 1024; // 1MB

    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY) {
        req.destroy();
        reject(new Error("Body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
