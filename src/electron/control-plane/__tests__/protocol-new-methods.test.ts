/**
 * Tests for new Control Plane Protocol methods, events, and error codes
 * added in the control-plane extensions commit.
 */
import { describe, expect, it } from "vitest";
import { Methods, Events, ErrorCodes } from "../protocol";

describe("New Methods constants", () => {
  it("has approval methods", () => {
    expect(Methods.APPROVAL_RESPOND).toBe("approval.respond");
    expect(Methods.APPROVAL_LIST).toBe("approval.list");
  });

  it("has task event methods", () => {
    expect(Methods.TASK_EVENTS).toBe("task.events");
    expect(Methods.TASK_CANCEL).toBe("task.cancel");
    expect(Methods.TASK_SEND_MESSAGE).toBe("task.sendMessage");
  });

  it("has workspace methods", () => {
    expect(Methods.WORKSPACE_LIST).toBe("workspace.list");
    expect(Methods.WORKSPACE_GET).toBe("workspace.get");
    expect(Methods.WORKSPACE_CREATE).toBe("workspace.create");
  });

  it("has channel methods", () => {
    expect(Methods.CHANNEL_LIST).toBe("channel.list");
    expect(Methods.CHANNEL_GET).toBe("channel.get");
    expect(Methods.CHANNEL_CREATE).toBe("channel.create");
    expect(Methods.CHANNEL_UPDATE).toBe("channel.update");
    expect(Methods.CHANNEL_TEST).toBe("channel.test");
    expect(Methods.CHANNEL_ENABLE).toBe("channel.enable");
    expect(Methods.CHANNEL_DISABLE).toBe("channel.disable");
    expect(Methods.CHANNEL_REMOVE).toBe("channel.remove");
  });

  it("has managed account methods", () => {
    expect(Methods.ACCOUNT_LIST).toBe("account.list");
    expect(Methods.ACCOUNT_GET).toBe("account.get");
    expect(Methods.ACCOUNT_UPSERT).toBe("account.upsert");
    expect(Methods.ACCOUNT_REMOVE).toBe("account.remove");
  });

  it("has config methods", () => {
    expect(Methods.CONFIG_GET).toBe("config.get");
    expect(Methods.CONFIG_SET).toBe("config.set");
    expect(Methods.LLM_CONFIGURE).toBe("llm.configure");
  });

  it("has agent methods", () => {
    expect(Methods.AGENT_WAKE).toBe("agent.wake");
    expect(Methods.AGENT_SEND).toBe("agent.send");
  });
});

describe("New Events constants", () => {
  it("has task lifecycle events", () => {
    expect(Events.TASK_CREATED).toBe("task.created");
    expect(Events.TASK_UPDATED).toBe("task.updated");
    expect(Events.TASK_COMPLETED).toBe("task.completed");
    expect(Events.TASK_FAILED).toBe("task.failed");
    expect(Events.TASK_EVENT).toBe("task.event");
  });

  it("has node events", () => {
    expect(Events.NODE_CONNECTED).toBe("node.connected");
    expect(Events.NODE_DISCONNECTED).toBe("node.disconnected");
  });

  it("has config event", () => {
    expect(Events.CONFIG_CHANGED).toBe("config.changed");
  });
});

describe("New ErrorCodes constants", () => {
  it("has node-related error codes", () => {
    expect(ErrorCodes.NODE_NOT_FOUND).toBe("NODE_NOT_FOUND");
    expect(ErrorCodes.NODE_UNAVAILABLE).toBe("NODE_UNAVAILABLE");
    expect(ErrorCodes.NODE_TIMEOUT).toBe("NODE_TIMEOUT");
    expect(ErrorCodes.NODE_PERMISSION_DENIED).toBe("NODE_PERMISSION_DENIED");
    expect(ErrorCodes.NODE_COMMAND_FAILED).toBe("NODE_COMMAND_FAILED");
    expect(ErrorCodes.NODE_BACKGROUND_UNAVAILABLE).toBe("NODE_BACKGROUND_UNAVAILABLE");
  });
});
