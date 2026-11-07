import { describe, expect, it } from "vitest";
import {
  EventTriggerCreateSchema,
  EventTriggerIdSchema,
  EventTriggerUpdateSchema,
  validateInput,
} from "../validation";

/** What Settings > Automations > Event Triggers sends for a new trigger. */
const formTrigger = {
  name: "Urgent deploy alert",
  enabled: true,
  source: "channel_message",
  conditions: [{ field: "text", operator: "contains", value: "urgent" }],
  conditionLogic: "all",
  action: {
    type: "create_task",
    config: { prompt: "Review the deploy request.", title: "Review deploy", workspaceId: "ws-1" },
  },
  workspaceId: "ws-1",
};

describe("event trigger IPC validation", () => {
  it("accepts the triggers the Settings form sends", () => {
    expect(validateInput(EventTriggerCreateSchema, formTrigger, "trigger")).toEqual(formTrigger);
    const mcp = {
      ...formTrigger,
      source: "mcp_event",
      conditions: [],
      cooldownMs: 0,
      action: {
        type: "wake_agent",
        config: {
          prompt: "Look at it",
          agentRoleId: "role-1",
          mcpEvent: { serverId: "srv", name: "issue.created", arguments: {}, delivery: "poll" },
        },
      },
    };
    expect(() => validateInput(EventTriggerCreateSchema, mcp, "trigger")).not.toThrow();
    expect(
      validateInput(EventTriggerUpdateSchema, { id: "t-1", updates: { enabled: false } }),
    ).toEqual({ id: "t-1", updates: { enabled: false } });
  });

  it("refuses action fields only the main process sets", () => {
    for (const extra of [
      { agentConfig: { autonomousMode: true } },
      { eventWait: { taskId: "t", expiresAt: 1 } },
      { speculateFix: {} },
    ]) {
      const payload = {
        ...formTrigger,
        action: { ...formTrigger.action, config: { ...formTrigger.action.config, ...extra } },
      };
      expect(() => validateInput(EventTriggerCreateSchema, payload, "trigger")).toThrow(
        /Invalid trigger/,
      );
    }
    expect(() =>
      validateInput(
        EventTriggerCreateSchema,
        { ...formTrigger, action: { type: "speculate_fix", config: {} } },
        "trigger",
      ),
    ).toThrow(/Invalid trigger/);
  });

  it("refuses malformed input", () => {
    expect(() => validateInput(EventTriggerCreateSchema, { ...formTrigger, name: "  " })).toThrow();
    expect(() =>
      validateInput(EventTriggerCreateSchema, {
        ...formTrigger,
        conditions: [{ field: "text", operator: "like", value: "x" }],
      }),
    ).toThrow();
    expect(() =>
      validateInput(EventTriggerUpdateSchema, { id: "t-1", updates: { fireCount: 99 } }),
    ).toThrow();
    // An update cannot replace the action of a trigger the main process made.
    expect(() =>
      validateInput(EventTriggerUpdateSchema, {
        id: "t-1",
        updates: { action: formTrigger.action },
      }),
    ).toThrow();
    expect(() => validateInput(EventTriggerIdSchema, 42)).toThrow();
  });
});
