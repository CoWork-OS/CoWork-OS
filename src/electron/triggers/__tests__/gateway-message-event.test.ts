import { describe, expect, it, vi } from "vitest";
import { EventTriggerService, MAX_HISTORY_FIELD_CHARS } from "../EventTriggerService";
import { channelMessageTriggerEvent } from "../gateway-message-event";
import type { GatewayEvent, MessageReceivedEventData } from "../../gateway/channels/types";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

/** A `message:received` event as the gateway router emits it. */
function gatewayMessageEvent(text: string, overrides: Partial<MessageReceivedEventData> = {}) {
  return {
    type: "message:received",
    channel: "slack",
    timestamp: new Date(1_700_000_000_000),
    data: {
      channelId: "channel-db-1",
      messageId: "msg-1",
      chatId: "C456",
      userId: "U123",
      senderName: "Ada Lovelace",
      text,
      preview: text.slice(0, 100),
      ...overrides,
    } satisfies MessageReceivedEventData,
  } satisfies GatewayEvent;
}

async function startService(db?: unknown) {
  const createTask = vi.fn().mockResolvedValue({ id: "task-1" });
  const service = new EventTriggerService(
    {
      createTask,
      getDefaultWorkspaceId: () => "ws-default",
      log: vi.fn(),
    },
    db,
  );
  await service.start();
  const trigger = await service.addTrigger({
    name: "Deploy requests",
    enabled: true,
    source: "channel_message",
    conditions: [{ field: "text", operator: "contains", value: "deploy" }],
    action: {
      type: "create_task",
      config: { prompt: "{{event.senderName}} asked: {{event.text}}" },
    },
    workspaceId: "ws-1",
    cooldownMs: 0,
  });
  return { service, trigger, createTask };
}

describe("channel_message triggers from gateway events", () => {
  it("maps the router's message fields onto the trigger event", () => {
    const event = channelMessageTriggerEvent(gatewayMessageEvent("Please DEPLOY it"));

    expect(event).toMatchObject({
      source: "channel_message",
      timestamp: 1_700_000_000_000,
      fields: {
        channelType: "slack",
        channelInstanceId: "channel-db-1",
        chatId: "C456",
        text: "Please DEPLOY it",
        senderName: "Ada Lovelace",
      },
    });
    expect(event?.eventId).toMatch(/^gateway-message-v1:[0-9a-f]{64}$/);
  });

  it("ignores other gateway events", () => {
    expect(
      channelMessageTriggerEvent({ type: "message:sent", timestamp: new Date(), data: {} }),
    ).toBeNull();
  });

  it("fires a `contains` condition on text and fills the prompt variables", async () => {
    const { service, createTask } = await startService();

    const event = channelMessageTriggerEvent(gatewayMessageEvent("Can you deploy staging?"));
    await service.evaluateEvent(event!);

    expect(createTask).toHaveBeenCalledOnce();
    expect(createTask.mock.calls[0][0]).toMatchObject({
      prompt: "Ada Lovelace asked: Can you deploy staging?",
      workspaceId: "ws-1",
    });
  });

  it("matches text past the 100-character preview", async () => {
    const { service, createTask } = await startService();
    const text = `${"status update ".repeat(10)}... and then deploy`;
    expect(text.slice(0, 100)).not.toContain("deploy");

    await service.evaluateEvent(channelMessageTriggerEvent(gatewayMessageEvent(text))!);

    expect(createTask).toHaveBeenCalledOnce();
  });

  it("does not fire when the text does not contain the value", async () => {
    const { service, createTask } = await startService();

    await service.evaluateEvent(channelMessageTriggerEvent(gatewayMessageEvent("hello there"))!);

    expect(createTask).not.toHaveBeenCalled();
  });

  it("caps long message text in run history but gives the action the full text", async () => {
    const { service, trigger, createTask } = await startService();
    const text = `deploy ${"x".repeat(MAX_HISTORY_FIELD_CHARS * 2)}`;

    await service.evaluateEvent(channelMessageTriggerEvent(gatewayMessageEvent(text))!);

    expect(createTask.mock.calls[0][0].prompt).toBe(`Ada Lovelace asked: ${text}`);
    const [entry] = service.getHistory(trigger.id);
    expect(entry.eventData.text).toBe(text.slice(0, MAX_HISTORY_FIELD_CHARS));
    expect(entry.eventData.senderName).toBe("Ada Lovelace");
  });

  (nativeSqliteAvailable ? it : it.skip)(
    "persists capped message text in the run history table",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const { service, trigger, createTask } = await startService(db);
      const text = `deploy ${"y".repeat(MAX_HISTORY_FIELD_CHARS * 2)}`;

      await service.evaluateEvent(channelMessageTriggerEvent(gatewayMessageEvent(text))!);
      await service.drainPendingEvents();

      expect(createTask.mock.calls[0][0].prompt).toBe(`Ada Lovelace asked: ${text}`);
      const row = db
        .prepare("SELECT event_data FROM event_trigger_history WHERE trigger_id = ?")
        .get(trigger.id) as { event_data: string };
      const stored = JSON.parse(row.event_data) as Record<string, unknown>;
      expect(stored.text).toBe(text.slice(0, MAX_HISTORY_FIELD_CHARS));
      expect(stored.senderName).toBe("Ada Lovelace");
      await service.stop();
      db.close();
    },
  );
});
