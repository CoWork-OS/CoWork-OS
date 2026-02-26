import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as http from "http";
import { WebAccessServer } from "../WebAccessServer";

function makeDeps() {
  return {
    handleIpcInvoke: vi.fn().mockResolvedValue({ tasks: [] }),
    getRendererPath: () => "/tmp/renderer",
    log: vi.fn(),
  };
}

/**
 * Helper: make an HTTP request to the server and return { status, headers, body }.
 */
function request(
  port: number,
  opts: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method || "GET",
        headers: opts.headers || {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("WebAccessServer", () => {
  let server: WebAccessServer;
  let deps: ReturnType<typeof makeDeps>;
  const TEST_TOKEN = "test-token-abc123";
  let testPort = 0;

  beforeEach(async () => {
    testPort = 18900 + Math.floor(Math.random() * 5000);
    deps = makeDeps();
    server = new WebAccessServer(
      { port: testPort, host: "127.0.0.1", token: TEST_TOKEN, enabled: true, allowedOrigins: [] },
      deps,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  // ── Lifecycle ─────────────────────────────────────────────────

  it("reports running status after start", () => {
    const status = server.getStatus();
    expect(status.running).toBe(true);
    expect(status.url).toContain(String(testPort));
    expect(status.startedAt).toBeGreaterThan(0);
  });

  it("reports stopped status after stop", async () => {
    await server.stop();
    const status = server.getStatus();
    expect(status.running).toBe(false);
    expect(status.url).toBeUndefined();
  });

  it("returns config with token", () => {
    const config = server.getConfig();
    expect(config.token).toBe(TEST_TOKEN);
    expect(config.port).toBe(testPort);
  });

  // ── Health check (no auth) ────────────────────────────────────

  it("GET /api/health returns 200 without auth", async () => {
    const res = await request(testPort, { path: "/api/health" });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeGreaterThan(0);
  });

  // ── Authentication ────────────────────────────────────────────

  it("rejects API requests without auth token", async () => {
    const res = await request(testPort, { path: "/api/tasks" });
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body).error).toBe("Unauthorized");
  });

  it("rejects API requests with wrong token", async () => {
    const res = await request(testPort, {
      path: "/api/tasks",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts API requests with correct token", async () => {
    const res = await request(testPort, {
      path: "/api/tasks",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects tokens of different length (timingSafeEqual guard)", async () => {
    const res = await request(testPort, {
      path: "/api/tasks",
      headers: { Authorization: "Bearer x" },
    });
    expect(res.status).toBe(401);
    // Should not crash — buffer length check prevents timingSafeEqual throw
  });

  it("rejects empty Bearer token", async () => {
    const res = await request(testPort, {
      path: "/api/tasks",
      headers: { Authorization: "Bearer " },
    });
    expect(res.status).toBe(401);
  });

  // ── CORS ──────────────────────────────────────────────────────

  it("responds to OPTIONS with 204", async () => {
    const res = await request(testPort, { path: "/api/tasks", method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  // ── API routing ───────────────────────────────────────────────

  it("GET /api/tasks routes to task:list IPC channel", async () => {
    deps.handleIpcInvoke.mockResolvedValue([{ id: "t1", title: "Test" }]);

    const res = await request(testPort, {
      path: "/api/tasks",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(deps.handleIpcInvoke).toHaveBeenCalledWith("task:list");
  });

  it("POST /api/tasks routes to task:create", async () => {
    deps.handleIpcInvoke.mockResolvedValue({ id: "new-task" });

    const res = await request(testPort, {
      path: "/api/tasks",
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "hello", workspaceId: "ws-1" }),
    });

    expect(res.status).toBe(200);
    expect(deps.handleIpcInvoke).toHaveBeenCalledWith(
      "task:create",
      expect.objectContaining({ prompt: "hello" }),
    );
  });

  it("GET /api/tasks/:id routes to task:get", async () => {
    deps.handleIpcInvoke.mockResolvedValue({ id: "abc", title: "Test" });

    const res = await request(testPort, {
      path: "/api/tasks/abc",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(deps.handleIpcInvoke).toHaveBeenCalledWith("task:get", "abc");
  });

  it("GET /api/workspaces routes to workspace:list", async () => {
    deps.handleIpcInvoke.mockResolvedValue([]);

    const res = await request(testPort, {
      path: "/api/workspaces",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(200);
    expect(deps.handleIpcInvoke).toHaveBeenCalledWith("workspace:list");
  });

  it("returns 404 for unknown API routes", async () => {
    const res = await request(testPort, {
      path: "/api/nonexistent",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).error).toBe("Not found");
  });

  // ── Error handling ────────────────────────────────────────────

  it("returns 500 when IPC handler throws", async () => {
    deps.handleIpcInvoke.mockRejectedValue(new Error("DB connection failed"));

    const res = await request(testPort, {
      path: "/api/tasks",
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });

    expect(res.status).toBe(500);
    expect(JSON.parse(res.body).error).toBe("DB connection failed");
  });

  // ── Token auto-generation ─────────────────────────────────────

  it("generates a token when none is provided", () => {
    const autoServer = new WebAccessServer(
      { port: 0, host: "127.0.0.1", enabled: true, token: "", allowedOrigins: [] },
      deps,
    );
    const config = autoServer.getConfig();
    expect(config.token).toBeDefined();
    expect(config.token.length).toBeGreaterThan(0);
  });
});
