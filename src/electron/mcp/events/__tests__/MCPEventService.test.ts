import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPEventService } from "../MCPEventService";
import { MCPSettingsManager } from "../../settings";
import type { EventTrigger } from "../../../triggers/types";

vi.mock("electron", () => ({ safeStorage: undefined }));

const key = Buffer.alloc(32, 7).toString("base64");
const running: MCPEventService[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.stop()));
  vi.restoreAllMocks();
  delete process.env.COWORK_MCP_EVENTS_KEY;
  delete process.env.COWORK_MCP_EVENTS_PUBLIC_URL;
});

function trigger(delivery: "webhook" | "poll"): EventTrigger {
  return {
    id: "trigger-1",
    name: "Review comments",
    enabled: true,
    source: "mcp_event",
    conditions: [],
    action: {
      type: "create_task",
      config: {
        prompt: "Review the comment",
        mcpEvent: {
          serverId: "server-1",
          name: "comment.created",
          arguments: { document_id: "doc-1" },
          delivery,
          ...(delivery === "webhook" ? { callbackUrl: "https://events.example" } : {}),
        },
      },
    },
    workspaceId: "workspace-1",
    cooldownMs: 0,
    fireCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function fixture(delivery: "webhook" | "poll") {
  vi.spyOn(MCPSettingsManager, "getServer").mockReturnValue({
    id: "server-1",
    name: "Server",
    enabled: true,
    transport: "stdio",
  });
  const db = new Database(":memory:");
  const active = new Map([["trigger-1", trigger(delivery)]]);
  const triggers = {
    listTriggers: () => [...active.values()],
    getTrigger: (id: string) => active.get(id),
    addTrigger: vi.fn(async (input: Any) => {
      const added = { ...input, id: "trigger-2" } as EventTrigger;
      active.set(added.id, added);
      return added;
    }),
    evaluateEvent: vi.fn(async () => {}),
  };
  const client = {
    acquireForExecutor: vi.fn(),
    releaseForExecutor: vi.fn(async () => {}),
    getServerStatus: vi.fn(() => ({ status: "connected" })),
    connectServer: vi.fn(async () => {}),
    requestServerEventMethod: vi.fn(async (_server: string, method: string) => {
      if (method === "events/subscribe")
        return {
          id: "sub-1",
          refreshBefore: new Date(Date.now() + 3_600_000).toISOString(),
          cursor: null,
        };
      if (method === "events/poll")
        return {
          events: [
            {
              eventId: "evt-1",
              name: "comment.created",
              timestamp: new Date().toISOString(),
              data: { text: "Please add dates" },
            },
          ],
          cursor: "cursor-1",
          hasMore: false,
          nextPollMs: 30_000,
        };
      return {};
    }),
  };
  const service = new MCPEventService(db, client as Any, triggers as Any, 0);
  running.push(service);
  return { db, active, triggers, client, service };
}

describe("MCPEventService", () => {
  it("holds the server connection across task completion and reconnects after restart", async () => {
    const { db, active, client, service } = fixture("poll");
    client.getServerStatus.mockReturnValue({ status: "disconnected" });
    await service.start();
    expect(client.acquireForExecutor).toHaveBeenCalledWith("mcp-event:trigger-1", "server-1");
    expect(client.connectServer).toHaveBeenCalledWith("server-1");
    active.clear();
    await service.sync();
    expect(client.releaseForExecutor).toHaveBeenCalledWith("mcp-event:trigger-1");
    db.close();
  });

  it("uses polling for a chat monitor when no public callback is configured", async () => {
    const { db, triggers, client, service } = fixture("poll");
    (client as Any).listServerEvents = vi.fn(async () => [
      {
        name: "comment.created",
        delivery: ["webhook", "poll"],
        inputSchema: { type: "object" },
        payloadSchema: { type: "object" },
      },
    ]);
    await service.start();
    await service.createFromTask({
      serverId: "server-1",
      eventName: "comment.created",
      arguments: { document_id: "doc-2" },
      instructions: "Review the new comment",
      workspaceId: "workspace-1",
      taskId: "task-1",
    });
    expect(triggers.addTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        action: expect.objectContaining({
          config: expect.objectContaining({
            runMode: "thread_follow_up",
            mcpEvent: expect.objectContaining({ delivery: "poll" }),
          }),
        }),
      }),
    );
    db.close();
  });

  it("reuses an explicit poll monitor when a webhook base URL is configured", async () => {
    process.env.COWORK_MCP_EVENTS_PUBLIC_URL = "https://events.example";
    const { db, triggers, client, service } = fixture("poll");
    (client as Any).listServerEvents = vi.fn(async () => [
      {
        name: "comment.created",
        delivery: ["webhook", "poll"],
        inputSchema: { type: "object" },
        payloadSchema: { type: "object" },
      },
    ]);
    await service.start();
    const input = {
      serverId: "server-1",
      eventName: "comment.created",
      arguments: { document_id: "doc-2" },
      instructions: "Review the new comment",
      delivery: "poll" as const,
      workspaceId: "workspace-1",
      taskId: "task-1",
    };
    const first = await service.createFromTask(input);
    const second = await service.createFromTask(input);
    expect(second.triggerId).toBe(first.triggerId);
    expect(triggers.addTrigger).toHaveBeenCalledOnce();
    db.close();
  });

  it("reconciles a removal requested while polling is in progress", async () => {
    const { db, active, client, service } = fixture("poll");
    let releasePoll: () => void = () => {};
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const original = client.requestServerEventMethod.getMockImplementation()!;
    client.requestServerEventMethod.mockImplementation(async (...args: Any[]) => {
      if (args[1] === "events/poll") await pollGate;
      return original(...args);
    });
    const starting = service.start();
    await vi.waitFor(() => expect(client.requestServerEventMethod).toHaveBeenCalled());
    active.clear();
    const removing = service.sync();
    releasePoll();
    await Promise.all([starting, removing]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mcp_event_subscriptions").get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it("persists a poll cursor only after accepting the event", async () => {
    const { db, triggers, client, service } = fixture("poll");
    await service.start();
    expect(triggers.evaluateEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "mcp_event",
        eventId: "server-1:evt-1",
        fields: expect.objectContaining({ subscriptionTriggerId: "trigger-1" }),
      }),
    );
    expect(db.prepare("SELECT cursor FROM mcp_event_subscriptions").get()).toEqual({
      cursor: "cursor-1",
    });
    expect(client.requestServerEventMethod).toHaveBeenCalledWith(
      "server-1",
      "events/poll",
      expect.objectContaining({ name: "comment.created", cursor: null }),
    );
    db.close();
  });

  it("verifies webhook signatures, echoes challenges, and rejects forged deliveries", async () => {
    process.env.COWORK_MCP_EVENTS_KEY = key;
    const { db, triggers, service } = fixture("webhook");
    await service.start();
    const port = service.receiverPort();
    expect(port).toBeTruthy();
    const row = db.prepare("SELECT * FROM mcp_event_subscriptions").get() as Any;
    expect(row.secret_encrypted).toMatch(/^env:/);
    const secret = (service as Any).decryptSecret(row.secret_encrypted) as string;
    const post = async (value: Record<string, unknown>, valid = true) => {
      const body = JSON.stringify(value);
      const id = String(value.eventId || "msg_verification_1");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
        .update(`${id}.${timestamp}.${body}`)
        .digest("base64");
      return fetch(`http://127.0.0.1:${port}/mcp-events/trigger-1`, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": timestamp,
          "webhook-signature": `v1,${valid ? signature : "bad"}`,
          "x-mcp-subscription-id": "sub-1",
        },
      });
    };
    const challenge = await post({ type: "verification", challenge: "one-use-challenge" });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toEqual({ challenge: "one-use-challenge" });
    const event = {
      eventId: "evt-2",
      name: "comment.created",
      timestamp: new Date().toISOString(),
      data: { text: "Review this" },
    };
    expect((await post(event, false)).status).toBe(401);
    expect(triggers.evaluateEvent).not.toHaveBeenCalled();
    expect((await post(event)).status).toBe(200);
    expect(triggers.evaluateEvent).toHaveBeenCalledOnce();
    db.close();
  });

  it("unsubscribes when the owning trigger is removed", async () => {
    process.env.COWORK_MCP_EVENTS_KEY = key;
    const { db, active, client, service } = fixture("webhook");
    await service.start();
    active.clear();
    await service.sync();
    expect(client.requestServerEventMethod).toHaveBeenCalledWith(
      "server-1",
      "events/unsubscribe",
      expect.objectContaining({
        name: "comment.created",
        delivery: expect.objectContaining({ mode: "webhook" }),
      }),
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM mcp_event_subscriptions").get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it("surfaces a server-reported webhook delivery failure and retries refresh", async () => {
    process.env.COWORK_MCP_EVENTS_KEY = key;
    const { db, client, service } = fixture("webhook");
    client.requestServerEventMethod.mockResolvedValueOnce({
      id: "sub-1",
      refreshBefore: new Date(Date.now() + 3_600_000).toISOString(),
      cursor: null,
      deliveryStatus: { active: false, lastError: "timeout" },
    });
    await service.start();
    const row = db
      .prepare("SELECT status, last_error, next_poll_at FROM mcp_event_subscriptions")
      .get() as Any;
    expect(row.status).toBe("error");
    expect(row.last_error).toContain("timeout");
    expect(row.next_poll_at).toBeLessThan(Date.now() + 31_000);
    db.close();
  });

  it("treats an already absent remote subscription as removed", async () => {
    process.env.COWORK_MCP_EVENTS_KEY = key;
    const { db, active, client, service } = fixture("webhook");
    await service.start();
    active.clear();
    client.requestServerEventMethod.mockRejectedValueOnce(
      Object.assign(new Error("NotFound"), { code: -32011 }),
    );
    await service.sync();
    expect(db.prepare("SELECT COUNT(*) AS count FROM mcp_event_subscriptions").get()).toEqual({
      count: 0,
    });
    db.close();
  });
});
