import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteAgentInvoker } from "../remote-invoker";
import type { ACPAgentCard } from "../types";

function remoteCard(overrides: Partial<ACPAgentCard> = {}): ACPAgentCard {
  return {
    id: "remote:a2a-test",
    name: "A2A Test Agent",
    description: "Remote protocol test agent",
    version: "1.0.0",
    capabilities: [],
    endpoint: "http://localhost:9090/a2a",
    origin: "remote",
    registeredAt: Date.now(),
    lastActiveAt: Date.now(),
    status: "available",
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("RemoteAgentInvoker", () => {
  it("sends the A2A v1 message parts shape", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      expect(request.method).toBe("message/send");
      expect(request.params.message.role).toBe("ROLE_USER");
      expect(request.params.message.parts).toEqual([
        { text: "Find the regression", mediaType: "text/plain" },
      ]);
      expect(request.params.message.parts[0]).not.toHaveProperty("kind");
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            id: "a2a-task-1",
            contextId: "context-1",
            status: {
              state: "TASK_STATE_COMPLETED",
              message: {
                role: "ROLE_AGENT",
                messageId: "message-2",
                parts: [{ text: "Regression found", mediaType: "text/plain" }],
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new RemoteAgentInvoker().invoke(remoteCard({ protocol: "a2a-v1" }), {
      assigneeId: "remote:a2a-test",
      title: "Regression",
      prompt: "Find the regression",
    });

    expect(result).toEqual({
      status: "completed",
      result: "Regression found",
      error: undefined,
      remoteTaskId: "a2a-task-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts direct-message responses and plain completed task states", async () => {
    const responses = [
      {
        messageId: "response-1",
        role: "ROLE_AGENT",
        parts: [{ text: "Direct response", mediaType: "text/plain" }],
      },
      {
        id: "task-2",
        status: { state: "completed", message: { messageId: "m2", role: "ROLE_AGENT", parts: [{ text: "Task response" }] } },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: responses.shift() }), { status: 200 });
      }),
    );

    const invoker = new RemoteAgentInvoker();
    const direct = await invoker.invoke(remoteCard({ protocol: "a2a-v1" }), {
      assigneeId: "remote:a2a-test",
      title: "Direct",
      prompt: "respond",
    });
    const task = await invoker.invoke(remoteCard({ protocol: "a2a-v1" }), {
      assigneeId: "remote:a2a-test",
      title: "Task",
      prompt: "respond",
    });

    expect(direct).toMatchObject({ status: "completed", result: "Direct response" });
    expect(task).toMatchObject({ status: "completed", result: "Task response", remoteTaskId: "task-2" });
  });

  it("rejects redirects before following them", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new RemoteAgentInvoker().invoke(remoteCard({ protocol: "a2a-v1" }), {
        assigneeId: "remote:a2a-test",
        title: "Redirect",
        prompt: "test",
      }),
    ).rejects.toThrow("redirects are not allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized remote responses before buffering the body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-length": String(4 * 1024 * 1024 + 1) },
        }),
      ),
    );

    await expect(
      new RemoteAgentInvoker().invoke(remoteCard({ protocol: "a2a-v1" }), {
        assigneeId: "remote:a2a-test",
        title: "Large",
        prompt: "test",
      }),
    ).rejects.toThrow("4 MiB");
  });

  it("keeps the legacy CoWork task dialect for explicitly legacy peers", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        methods.push(request.method);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { taskId: "legacy-1", status: "completed", result: "done" },
          }),
          { status: 200 },
        );
      }),
    );

    const result = await new RemoteAgentInvoker().invoke(
      remoteCard({ protocol: "cowork-legacy" }),
      {
        assigneeId: "remote:legacy",
        title: "Legacy",
        prompt: "Keep compatibility",
      },
    );

    expect(methods).toEqual(["tasks/send"]);
    expect(result.status).toBe("completed");
  });

  it("does not create a duplicate legacy task after an ambiguous transport failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connection reset after write");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new RemoteAgentInvoker().invoke(remoteCard({ protocol: "cowork-legacy" }), {
        assigneeId: "remote:legacy",
        title: "Ambiguous",
        prompt: "Run once",
      }),
    ).rejects.toThrow("connection reset");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to tasks/create only for an explicit method-not-found response", async () => {
    const methods: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        methods.push(request.method);
        return new Response(
          JSON.stringify(
            request.method === "tasks/send"
              ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }
              : { jsonrpc: "2.0", id: request.id, result: { taskId: "created-1", status: "running" } },
          ),
          { status: 200 },
        );
      }),
    );

    await new RemoteAgentInvoker().invoke(remoteCard({ protocol: "cowork-legacy" }), {
      assigneeId: "remote:legacy",
      title: "Fallback",
      prompt: "Run",
    });
    expect(methods).toEqual(["tasks/send", "tasks/create"]);
  });

  it("resolves credential references without persisting inline authorization", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer resolved-token");
      const request = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { status: "completed" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await new RemoteAgentInvoker(async (ref) => (ref === "test-ref" ? "resolved-token" : undefined)).invoke(
      remoteCard({ metadata: { credentialRef: "test-ref" } }),
      { assigneeId: "remote:secret", title: "Secret", prompt: "test" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses inline authorization secrets", async () => {
    await expect(
      new RemoteAgentInvoker().invoke(remoteCard({ metadata: { bearerToken: "do-not-store" } }), {
        assigneeId: "remote:secret",
        title: "Secret",
        prompt: "test",
      }),
    ).rejects.toThrow("metadata.credentialRef");
  });

  it("refuses credentials embedded in endpoint URLs", async () => {
    await expect(
      new RemoteAgentInvoker().invoke(
        remoteCard({ endpoint: "https://user:password@example.com/a2a" }),
        { assigneeId: "remote:secret", title: "Secret", prompt: "test" },
      ),
    ).rejects.toThrow("cannot contain credentials");
  });
});
