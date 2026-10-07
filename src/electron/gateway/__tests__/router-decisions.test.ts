import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cowork-fixture" },
  BrowserWindow: { getAllWindows: () => [] },
}));
import { MessageRouter } from "../router";
function fixture() {
  const db = {
    prepare: vi.fn(() => ({ run: vi.fn(), get: vi.fn(), all: () => [] })),
    transaction: vi.fn((fn) => fn),
  } as Any;
  const daemon = { respondToApproval: vi.fn().mockResolvedValue("handled") } as Any;
  const router = new MessageRouter(db, {}, daemon);
  const inner = router as Any;
  const decisionHandlers: Any[] = [];
  const adapter = {
    type: "slack",
    status: "connected",
    sendMessage: vi.fn().mockResolvedValue("plain"),
    sendDecision: vi.fn(),
    onDecision: vi.fn((handler) => decisionHandlers.push(handler)),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
  } as Any;
  inner.channelRepo.findById = vi
    .fn()
    .mockResolvedValue({ id: "channel", config: { decisionMessagesEnabled: true } });
  inner.taskRepo.findById = vi.fn().mockResolvedValue({ id: "child", title: "Child" });
  inner.clearTransientTaskProgress = vi.fn();
  inner.resolveRouteForTask = vi.fn().mockResolvedValue({
    adapter,
    channelId: "channel",
    chatId: "chat",
    sessionId: "session",
    requestingUserId: "actor",
    routedTaskId: "root",
  });
  return { router, inner, daemon, adapter, decisionHandlers };
}
describe("router typed decisions", () => {
  it("routes child approvals through durable service without a legacy approval map", async () => {
    const f = fixture();
    f.inner.decisionService.publish = vi.fn().mockResolvedValue({ state: "sent" });
    await f.router.sendApprovalRequest("child", { id: "approval" });
    expect(f.inner.decisionService.publish).toHaveBeenCalledWith({
      approvalId: "approval",
      sessionId: "session",
      actorId: "actor",
    });
    expect(f.inner.pendingApprovals.size).toBe(0);
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
  });
  it("uses desktop text fallback before an unsupported typed request and creates no legacy buttons", async () => {
    const f = fixture();
    f.inner.decisionService.publish = vi.fn().mockRejectedValue(new Error("not authorized"));
    await f.router.sendApprovalRequest("child", { id: "approval" });
    expect(f.adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ parseMode: "text", text: expect.stringContaining("CoWork") }),
    );
    expect(f.inner.pendingApprovals.size).toBe(0);
  });
  it("does not send fallback text after uncertain publication", async () => {
    const f = fixture();
    f.inner.decisionService.publish = vi.fn().mockResolvedValue({ state: "delivery_unknown" });
    await f.router.sendApprovalRequest("child", { id: "approval" });
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
  });
  it.each([
    { contextType: "dm", requester: "actor", callbackUser: "another-user" },
    { contextType: "group", requester: "actor", callbackUser: "another-user" },
    { contextType: "dm", requester: undefined, callbackUser: "actor" },
  ])(
    "rejects a legacy inline approval without the exact requester ($contextType)",
    async (input) => {
      const f = fixture();
      f.inner.pendingApprovals.set("approval", {
        taskId: "task",
        approval: { id: "approval", description: "Review" },
        sessionId: "session",
        chatId: "chat",
        channelType: "slack",
        requestingUserId: input.requester,
        requestingUserName: "Owner",
        contextType: input.contextType,
      });
      await f.inner.handleApprovalCallback(
        f.adapter,
        {
          id: "callback",
          userId: input.callbackUser,
          userName: "Other",
          chatId: "chat",
          messageId: "message",
          data: "approve:approval",
        },
        "session",
        "approval",
        true,
      );
      expect(f.daemon.respondToApproval).not.toHaveBeenCalled();
      expect(f.inner.pendingApprovals.has("approval")).toBe(true);
      expect(f.adapter.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining("Only") }),
      );
    },
  );
  it("allows the original requester to use a legacy inline approval in a direct message", async () => {
    const f = fixture();
    f.inner.pendingApprovals.set("approval", {
      taskId: "task",
      approval: { id: "approval", description: "Review" },
      revisionHash: "a".repeat(64),
      sessionId: "session",
      chatId: "chat",
      channelType: "slack",
      requestingUserId: "actor",
      contextType: "dm",
    });
    await f.inner.handleApprovalCallback(
      f.adapter,
      {
        id: "callback",
        userId: "actor",
        userName: "Owner",
        chatId: "chat",
        messageId: "message",
        data: "approve:approval",
      },
      "session",
      "approval",
      true,
    );
    // The decision is bound to the exact request revision that was shown in the chat.
    expect(f.daemon.respondToApproval).toHaveBeenCalledWith(
      "approval",
      true,
      undefined,
      undefined,
      "a".repeat(64),
    );
    expect(f.inner.pendingApprovals.has("approval")).toBe(false);
  });
  it("stores the displayed revision when publishing a legacy approval prompt", async () => {
    const f = fixture();
    f.inner.channelRepo.findById = vi.fn().mockResolvedValue({ id: "channel", config: {} });
    const approval = {
      id: "legacy",
      taskId: "child",
      type: "run_command",
      description: "Run the fixture",
      details: { command: "true" },
      requestedAt: 1,
    };
    const { approvalRequestRevisionHash } = await import("../../agent/approval-revision");
    const displayed = approvalRequestRevisionHash(approval);
    await f.router.sendApprovalRequest("child", { ...approval, revisionHash: displayed });
    expect(f.inner.pendingApprovals.get("legacy")?.revisionHash).toBe(displayed);
    // A presented hash that does not match the content is recomputed from the content.
    await f.router.sendApprovalRequest("child", {
      ...approval,
      id: "tampered",
      revisionHash: "b".repeat(64),
    });
    expect(f.inner.pendingApprovals.get("tampered")?.revisionHash).toBe(
      approvalRequestRevisionHash({ ...approval, id: "tampered" }),
    );
    // Exact reviews never get a hash on a chat surface that cannot show their bytes, so
    // the daemon keeps refusing those legacy decisions.
    for (const [id, details] of [
      ["files", { reviewFiles: ["notes.md"] }],
      ["draft", { draftRevision: { state: "bound" } }],
      ["write", { responsibilityActionReview: { version: 1 } }],
    ] as const) {
      const review = { ...approval, id, details };
      await f.router.sendApprovalRequest("child", {
        ...review,
        revisionHash: approvalRequestRevisionHash(review),
      });
      expect(f.inner.pendingApprovals.get(id)?.revisionHash).toBeUndefined();
    }
  });
  it("binds callbacks to registered channel IDs and ignores replaced adapters or shutdown", async () => {
    const f = fixture();
    const handle = vi.fn();
    f.inner.decisionService.handle = handle;
    f.router.registerAdapter(f.adapter, "channel");
    const event = { routeId: "route", actorId: "actor" };
    await f.decisionHandlers[0](event);
    expect(handle).toHaveBeenCalledWith("channel", event);
    f.inner.adaptersByChannelId.set("channel", {});
    await f.decisionHandlers[0](event);
    expect(handle).toHaveBeenCalledOnce();
    f.inner.adaptersByChannelId.set("channel", f.adapter);
    f.inner.shuttingDown = true;
    await f.decisionHandlers[0](event);
    expect(handle).toHaveBeenCalledOnce();
  });
  it("passes allow-once/deny-once, attribution, revision and transaction guard to the daemon", async () => {
    const f = fixture();
    const input = {
      approvalId: "approval",
      approved: true,
      attribution: { principalId: "gateway:slack:actor", role: "owner" },
      expectedRevisionHash: "revision",
      guard: { routeId: "route", claimId: "claim" },
    };
    await f.inner.decisionService.dependencies.respond(input);
    expect(f.daemon.respondToApproval).toHaveBeenCalledWith(
      "approval",
      true,
      "allow_once",
      input.attribution,
      "revision",
      input.guard,
    );
    await f.inner.decisionService.dependencies.respond({ ...input, approved: false });
    expect(f.daemon.respondToApproval).toHaveBeenLastCalledWith(
      "approval",
      false,
      "deny_once",
      input.attribution,
      "revision",
      input.guard,
    );
  });
});
