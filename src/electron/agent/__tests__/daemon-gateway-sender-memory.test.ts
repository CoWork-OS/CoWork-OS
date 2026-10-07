/**
 * SEC-16: a channel message from someone other than the workspace owner never feeds the
 * owner's profile (awareness beliefs) or response style.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureConversation: vi.fn(),
  captureFeedback: vi.fn(),
  observe: vi.fn(),
  observeFeedback: vi.fn(),
  capture: vi.fn(async () => null),
}));

vi.mock("../../awareness/AwarenessService", () => ({
  getAwarenessService: () => ({
    captureConversation: mocks.captureConversation,
    captureFeedback: mocks.captureFeedback,
  }),
}));
vi.mock("../../memory/AdaptiveStyleEngine", () => ({
  AdaptiveStyleEngine: { observe: mocks.observe, observeFeedback: mocks.observeFeedback },
}));
vi.mock("../../memory/MemoryService", () => ({
  MemoryService: { capture: mocks.capture },
}));

import { AgentDaemon } from "../daemon";

function daemonFor(agentConfig: Record<string, unknown>) {
  return {
    taskRepo: {
      findById: vi.fn(() => ({
        id: "task-1",
        workspaceId: "ws-1",
        title: "t",
        prompt: "p",
        agentConfig,
      })),
    },
    getEffectiveWorkspaceForTask: vi.fn(() => undefined),
  } as Any;
}

const capture = (daemon: Any, type: string, payload: Record<string, unknown>) =>
  (AgentDaemon.prototype as Any).captureToMemory.call(daemon, "task-1", type, payload);

describe("captureToMemory and gateway senders (SEC-16)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("learns from the owner's own messages", async () => {
    await capture(daemonFor({}), "user_message", {
      message: "Call me Sam, I prefer short answers",
    });
    await capture(
      daemonFor({ originChannel: "whatsapp", gatewaySenderIsOwner: true }),
      "user_message",
      { message: "I prefer short answers" },
    );
    expect(mocks.captureConversation).toHaveBeenCalledTimes(2);
    expect(mocks.observe).toHaveBeenCalledTimes(2);
  });

  it("ignores a third party's DM for the profile and style", async () => {
    const thirdParty = daemonFor({
      originChannel: "telegram",
      gatewayContext: "private",
      gatewaySenderIsOwner: false,
      gatewaySenderRef: "gateway:telegram:42",
    });
    await capture(thirdParty, "user_message", { message: "Call me Bob. My goal is to ship" });
    await capture(thirdParty, "user_feedback", { decision: "rejected", reason: "too verbose" });
    // A channel task created before the sender was recorded counts as third-party too.
    await capture(daemonFor({ originChannel: "slack" }), "user_message", {
      message: "I prefer emoji",
    });
    expect(mocks.captureConversation).not.toHaveBeenCalled();
    expect(mocks.captureFeedback).not.toHaveBeenCalled();
    expect(mocks.observe).not.toHaveBeenCalled();
    expect(mocks.observeFeedback).not.toHaveBeenCalled();
  });
});
