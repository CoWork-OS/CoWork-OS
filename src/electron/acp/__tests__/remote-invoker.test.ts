import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ACPAgentCard } from "../types";
import { RemoteAgentInvoker } from "../remote-invoker";
import { afterEach, describe, expect, it } from "vitest";

describe("RemoteAgentInvoker dispatch fallback", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = undefined;
  });

  it("does not retry tasks/create when tasks/send committed but its response was lost", async () => {
    const methods: string[] = [];
    const effects: string[] = [];
    const endpoint = await startServer(async (request, response, payload) => {
      methods.push(payload.method);
      if (payload.method === "tasks/send") {
        effects.push("remote-effect-1");
        response.destroy();
        return;
      }
      effects.push("unexpected-second-effect");
      writeResult(response, payload.id, { status: "running", taskId: "remote-effect-2" });
    });

    await expect(
      new RemoteAgentInvoker().invoke(makeAgent(endpoint), makeTask()),
    ).rejects.toThrow();

    expect(methods).toEqual(["tasks/send"]);
    expect(effects).toEqual(["remote-effect-1"]);
  });

  it("preserves a pending tasks/send result with an identity without falling back", async () => {
    const methods: string[] = [];
    const endpoint = await startServer(async (_request, response, payload) => {
      methods.push(payload.method);
      writeResult(response, payload.id, { status: "pending", taskId: "remote-pending-1" });
    });

    const result = await new RemoteAgentInvoker().invoke(makeAgent(endpoint), makeTask());

    expect(result).toMatchObject({ status: "pending", remoteTaskId: "remote-pending-1" });
    expect(methods).toEqual(["tasks/send"]);
  });

  it.each(["HTTP failure", "invalid JSON", "mismatched response ID"])(
    "does not fall back to tasks/create after %s uncertainty",
    async (failure) => {
      const methods: string[] = [];
      const endpoint = await startServer(async (_request, response, payload) => {
        methods.push(payload.method);
        if (failure === "HTTP failure") {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "temporarily unavailable" }));
          return;
        }
        if (failure === "mismatched response ID") {
          writeResult(response, "wrong-request-id", {
            status: "running",
            taskId: "remote-ambiguous-task",
          });
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{invalid JSON");
      });

      await expect(
        new RemoteAgentInvoker().invoke(makeAgent(endpoint), makeTask()),
      ).rejects.toThrow();
      expect(methods).toEqual(["tasks/send"]);
    },
  );

  it.each(["running", "failed", "cancelled"])(
    "preserves async-create status %s after explicit method-not-found",
    async (status) => {
      const methods: string[] = [];
      const endpoint = await startServer(async (_request, response, payload) => {
        methods.push(payload.method);
        if (payload.method === "tasks/send") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              error: { code: -32601, message: "Method not found" },
            }),
          );
          return;
        }
        writeResult(response, payload.id, { status, taskId: "remote-created-1" });
      });

      const result = await new RemoteAgentInvoker().invoke(makeAgent(endpoint), makeTask());

      expect(result).toMatchObject({ status, remoteTaskId: "remote-created-1" });
      expect(methods).toEqual(["tasks/send", "tasks/create"]);
    },
  );

  it.each([
    ["HTTP 404", { http: 404 }],
    ["HTTP 405", { http: 405 }],
    ["HTTP 501", { http: 501 }],
    ["JSON-RPC -32600", { code: -32600 }],
  ] as const)(
    "falls back to tasks/create when tasks/send is definitively rejected (%s)",
    async (_label, rejection) => {
      const methods: string[] = [];
      const endpoint = await startServer(async (_request, response, payload) => {
        methods.push(payload.method);
        if (payload.method === "tasks/send") {
          if ("http" in rejection) {
            response.writeHead(rejection.http, { "content-type": "text/plain" });
            response.end("not supported");
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id,
              error: { code: rejection.code, message: "Invalid Request" },
            }),
          );
          return;
        }
        writeResult(response, payload.id, { status: "running", taskId: "remote-created-2" });
      });

      const result = await new RemoteAgentInvoker().invoke(makeAgent(endpoint), makeTask());

      expect(result).toMatchObject({ status: "running", remoteTaskId: "remote-created-2" });
      expect(methods).toEqual(["tasks/send", "tasks/create"]);
    },
  );

  async function startServer(
    handler: (
      request: import("node:http").IncomingMessage,
      response: ServerResponse,
      payload: { id: string; method: string; params: Record<string, unknown> },
    ) => Promise<void>,
  ): Promise<string> {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      await handler(
        request,
        response,
        JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: string;
          method: string;
          params: Record<string, unknown>;
        },
      );
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
});

function makeAgent(endpoint: string): ACPAgentCard {
  return {
    id: "remote-test-agent",
    name: "Remote test agent",
    description: "A fake ACP endpoint",
    version: "1.0.0",
    capabilities: [],
    endpoint,
    origin: "remote",
    registeredAt: Date.now(),
    lastActiveAt: Date.now(),
    status: "available",
  };
}

function makeTask() {
  return {
    assigneeId: "remote-test-agent",
    title: "Disposable test effect",
    prompt: "Test prompt",
    workspaceId: "test-workspace",
  };
}

function writeResult(response: ServerResponse, id: string, result: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
