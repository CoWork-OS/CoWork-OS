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
    expect(Methods.INPUT_REQUEST_LIST).toBe("input_request.list");
    expect(Methods.INPUT_REQUEST_RESPOND).toBe("input_request.respond");
  });

  it("has task event methods", () => {
    expect(Methods.TASK_EVENTS).toBe("task.events");
    expect(Methods.TASK_CANCEL).toBe("task.cancel");
    expect(Methods.TASK_SEND_MESSAGE).toBe("task.sendMessage");
  });

  it("has managed agent methods", () => {
    expect(Methods.MANAGED_AGENT_LIST).toBe("managedAgent.list");
    expect(Methods.MANAGED_AGENT_GET).toBe("managedAgent.get");
    expect(Methods.MANAGED_AGENT_CREATE).toBe("managedAgent.create");
    expect(Methods.MANAGED_AGENT_UPDATE).toBe("managedAgent.update");
    expect(Methods.MANAGED_AGENT_ARCHIVE).toBe("managedAgent.archive");
    expect(Methods.MANAGED_AGENT_VERSION_LIST).toBe("managedAgent.version.list");
    expect(Methods.MANAGED_AGENT_VERSION_GET).toBe("managedAgent.version.get");
  });

  it("has managed environment methods", () => {
    expect(Methods.MANAGED_ENVIRONMENT_LIST).toBe("managedEnvironment.list");
    expect(Methods.MANAGED_ENVIRONMENT_GET).toBe("managedEnvironment.get");
    expect(Methods.MANAGED_ENVIRONMENT_CREATE).toBe("managedEnvironment.create");
    expect(Methods.MANAGED_ENVIRONMENT_UPDATE).toBe("managedEnvironment.update");
    expect(Methods.MANAGED_ENVIRONMENT_ARCHIVE).toBe("managedEnvironment.archive");
  });

  it("has managed session methods", () => {
    expect(Methods.MANAGED_SESSION_LIST).toBe("managedSession.list");
    expect(Methods.MANAGED_SESSION_GET).toBe("managedSession.get");
    expect(Methods.MANAGED_SESSION_CREATE).toBe("managedSession.create");
    expect(Methods.MANAGED_SESSION_CANCEL).toBe("managedSession.cancel");
    expect(Methods.MANAGED_SESSION_RESUME).toBe("managedSession.resume");
    expect(Methods.MANAGED_SESSION_SEND_EVENT).toBe("managedSession.sendEvent");
    expect(Methods.MANAGED_SESSION_EVENTS_LIST).toBe("managedSession.events.list");
  });

  it("has Everyday Agent methods", () => {
    expect(Methods.EVERYDAY_AGENT_GET_PROFILE).toBe("everydayAgent.getProfile");
    expect(Methods.EVERYDAY_AGENT_UPDATE_PROFILE).toBe("everydayAgent.updateProfile");
    expect(Methods.EVERYDAY_AGENT_ACCEPT_CONSENT).toBe("everydayAgent.acceptConsent");
    expect(Methods.EVERYDAY_AGENT_PAUSE).toBe("everydayAgent.pause");
    expect(Methods.EVERYDAY_AGENT_REVOKE_CAPABILITY).toBe("everydayAgent.revokeCapability");
    expect(Methods.EVERYDAY_AGENT_LIST_RECEIPTS).toBe("everydayAgent.listReceipts");
    expect(Methods.EVERYDAY_AGENT_CLEAR_DATA).toBe("everydayAgent.clearData");
    expect(Methods.EVERYDAY_AGENT_PREVIEW_ACTION).toBe("everydayAgent.previewAction");
    expect(Methods.EVERYDAY_AGENT_APPROVE_ACTION).toBe("everydayAgent.approveAction");
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

  it("has managed session events", () => {
    expect(Events.MANAGED_SESSION_CREATED).toBe("managedSession.created");
    expect(Events.MANAGED_SESSION_UPDATED).toBe("managedSession.updated");
    expect(Events.MANAGED_SESSION_EVENT).toBe("managedSession.event");
    expect(Events.MANAGED_SESSION_COMPLETED).toBe("managedSession.completed");
    expect(Events.MANAGED_SESSION_FAILED).toBe("managedSession.failed");
  });

  it("no longer defines retired mobile companion events", () => {
    expect(Object.values(Events).some((event) => event.startsWith("node."))).toBe(false);
  });

  it("has config event", () => {
    expect(Events.CONFIG_CHANGED).toBe("config.changed");
  });
});

describe("New ErrorCodes constants", () => {
  it("no longer defines retired mobile companion error codes", () => {
    expect(Object.keys(ErrorCodes).some((code) => code.startsWith("NODE_"))).toBe(false);
  });
});
