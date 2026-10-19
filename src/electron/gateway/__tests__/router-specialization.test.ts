import { describe, expect, it, vi } from "vitest";

vi.mock("better-sqlite3", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 1 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
      close: vi.fn(),
    })),
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([]),
  },
}));

import { MessageRouter } from "../router";

function createMockDb() {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn().mockReturnValue({ changes: 1 }),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    transaction: vi.fn((fn: Any) => fn),
  } as Any;
}

function makeRouter() {
  const agentDaemon = {
    startTask: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    registerArtifact: vi.fn(),
  };
  const router = new MessageRouter(createMockDb(), {}, agentDaemon as Any);
  const adapter = {
    type: "telegram",
    sendMessage: vi.fn().mockResolvedValue("msg-1"),
  } as Any;
  const channel = {
    id: "channel-1",
    type: "telegram",
    config: { defaultAgentRoleId: "role-channel" },
  };
  (router as Any).getChannelForAdapter = vi.fn().mockReturnValue(channel);
  (router as Any).getChannelIdForAdapter = vi.fn().mockReturnValue("channel-1");
  (router as Any).persistInboundAttachments = vi.fn().mockResolvedValue([]);
  (router as Any).maybeUpdatePrioritiesFromVoiceMessage = vi.fn().mockResolvedValue(undefined);
  (router as Any).sendAdapterMessage = vi.fn((targetAdapter: Any, message: Any) =>
    targetAdapter.sendMessage(message),
  );
  (router as Any).messageRepo.create = vi.fn();
  return { router, adapter, agentDaemon };
}

describe("MessageRouter channel specialization", () => {
  it("creates new tasks with specialized workspace, role, prompt guidance, memory, and restrictions", async () => {
    const { router, adapter, agentDaemon } = makeRouter();
    (router as Any).sessionRepo.findById = vi.fn().mockReturnValue({
      id: "session-1",
      channelId: "channel-1",
      workspaceId: "ws-special",
      taskId: undefined,
      context: {},
    });
    (router as Any).workspaceRepo.findById = vi.fn().mockReturnValue({
      id: "ws-special",
      name: "Special Workspace",
      path: "/tmp/ws-special",
      permissions: {},
    });
    (router as Any).taskRepo.create = vi.fn().mockImplementation((input: Any) => ({
      id: "task-1",
      ...input,
    }));
    (router as Any).taskRepo.update = vi.fn();
    (router as Any).sessionManager.linkSessionToTask = vi.fn();
    (router as Any).sessionManager.updateSessionContext = vi.fn();

    await (router as Any).forwardToDesktopApp(
      adapter,
      {
        chatId: "chat-1",
        messageId: "message-1",
        userId: "user-1",
        userName: "Ada",
        text: "triage this incident",
        timestamp: new Date(),
        isGroup: true,
      },
      "session-1",
      {
        contextType: "group",
        deniedTools: ["group:memory"],
        channelSpecialization: {
          id: "spec-1",
          workspaceId: "ws-special",
          agentRoleId: "role-special",
          systemGuidance: "Act as the incident triage lead.",
          toolRestrictions: ["shell_command"],
          allowSharedContextMemory: true,
        },
      },
    );

    expect((router as Any).taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-special",
        prompt: expect.stringContaining("Act as the incident triage lead."),
        agentConfig: expect.objectContaining({
          gatewayContext: "group",
          allowSharedContextMemory: true,
          channelSpecializationId: "spec-1",
          toolRestrictions: expect.arrayContaining(["group:memory", "shell_command"]),
        }),
      }),
    );
    expect((router as Any).taskRepo.update).toHaveBeenCalledWith("task-1", {
      assignedAgentRoleId: "role-special",
    });
    expect(agentDaemon.startTask).toHaveBeenCalledWith(
      expect.objectContaining({ assignedAgentRoleId: "role-special" }),
    );
  });

  it("keeps active task follow-ups on the existing task instead of switching specialization", async () => {
    const { router, adapter, agentDaemon } = makeRouter();
    (router as Any).sessionRepo.findById = vi.fn().mockReturnValue({
      id: "session-1",
      channelId: "channel-1",
      workspaceId: "ws-old",
      taskId: "task-active",
      context: {},
    });
    (router as Any).workspaceRepo.findById = vi.fn().mockReturnValue({
      id: "ws-old",
      name: "Old Workspace",
      path: "/tmp/ws-old",
      permissions: {},
    });
    (router as Any).taskRepo.findById = vi.fn().mockReturnValue({
      id: "task-active",
      status: "executing",
    });
    (router as Any).taskRepo.create = vi.fn();

    await (router as Any).forwardToDesktopApp(
      adapter,
      {
        chatId: "chat-1",
        messageId: "message-1",
        userId: "user-1",
        userName: "Ada",
        text: "also check logs",
        timestamp: new Date(),
        isGroup: true,
      },
      "session-1",
      {
        contextType: "group",
        channelSpecialization: {
          id: "spec-2",
          workspaceId: "ws-new",
          agentRoleId: "role-new",
        },
      },
    );

    // A group message is never the owner's own words, so it carries no provenance.
    expect(agentDaemon.sendMessage).toHaveBeenCalledWith(
      "task-active",
      "also check logs",
      undefined,
      undefined,
      undefined,
    );
    expect((router as Any).taskRepo.create).not.toHaveBeenCalled();
  });

  it("starts a new specialized task after a completed task", async () => {
    const { router, adapter } = makeRouter();
    (router as Any).sessionRepo.findById = vi
      .fn()
      .mockReturnValueOnce({
        id: "session-1",
        channelId: "channel-1",
        workspaceId: "ws-old",
        taskId: "task-done",
        context: {},
      })
      .mockReturnValue({
        id: "session-1",
        channelId: "channel-1",
        workspaceId: "ws-new",
        taskId: undefined,
        context: {},
      });
    (router as Any).workspaceRepo.findById = vi.fn((id: string) => ({
      id,
      name: id,
      path: `/tmp/${id}`,
      permissions: {},
    }));
    (router as Any).taskRepo.findById = vi.fn().mockReturnValue({
      id: "task-done",
      status: "completed",
    });
    (router as Any).taskRepo.create = vi.fn().mockImplementation((input: Any) => ({
      id: "task-new",
      ...input,
    }));
    (router as Any).taskRepo.update = vi.fn();
    (router as Any).sessionManager.unlinkSessionFromTask = vi.fn();
    (router as Any).sessionManager.setSessionWorkspace = vi.fn();
    (router as Any).sessionManager.linkSessionToTask = vi.fn();
    (router as Any).sessionManager.updateSessionContext = vi.fn();

    await (router as Any).forwardToDesktopApp(
      adapter,
      {
        chatId: "chat-1",
        messageId: "message-1",
        userId: "user-1",
        userName: "Ada",
        text: "new topic",
        timestamp: new Date(),
        isGroup: true,
      },
      "session-1",
      {
        contextType: "group",
        channelSpecialization: {
          id: "spec-3",
          workspaceId: "ws-new",
          agentRoleId: "role-new",
        },
      },
    );

    expect((router as Any).sessionManager.unlinkSessionFromTask).toHaveBeenCalledWith("session-1");
    expect((router as Any).sessionManager.setSessionWorkspace).toHaveBeenCalledWith(
      "session-1",
      "ws-new",
    );
    expect((router as Any).taskRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-new" }),
    );
    expect((router as Any).taskRepo.update).toHaveBeenCalledWith("task-new", {
      assignedAgentRoleId: "role-new",
    });
  });

  it("keys sessions by thread id when a channel provides one", () => {
    const { router } = makeRouter();
    expect(
      (router as Any).getSessionChatKey({
        chatId: "chat-1",
        threadId: "topic-1",
      }),
    ).toBe("chat-1::thread:topic-1");
    expect((router as Any).getSessionChatKey({ chatId: "chat-1" })).toBe("chat-1");
  });
});

describe("MessageRouter follow-up provenance", () => {
  const RULE_REQUEST = "Add a behavioral rule: always answer in French.";
  const makeFollowUpRouter = () => {
    const made = makeRouter();
    const { router } = made;
    (router as Any).getChannelForAdapter = vi.fn().mockReturnValue({
      id: "channel-1",
      type: "telegram",
      config: { ownerUserIds: ["owner-1"] },
    });
    (router as Any).sessionRepo.findById = vi.fn().mockReturnValue({
      id: "session-1",
      channelId: "channel-1",
      workspaceId: "ws-1",
      taskId: "task-active",
      context: {},
    });
    (router as Any).workspaceRepo.findById = vi.fn().mockReturnValue({
      id: "ws-1",
      name: "Workspace",
      path: "/tmp/ws-1",
      permissions: {},
    });
    (router as Any).taskRepo.findById = vi.fn().mockReturnValue({
      id: "task-active",
      status: "executing",
    });
    return made;
  };
  const directMessage = (userId: string) => ({
    chatId: userId,
    messageId: "message-1",
    userId,
    userName: "Sender",
    text: RULE_REQUEST,
    timestamp: new Date(),
    isGroup: false,
  });

  it("marks only the verified owner's follow-up as typed by the user", async () => {
    const owner = makeFollowUpRouter();
    await (owner.router as Any).forwardToDesktopApp(
      owner.adapter,
      directMessage("owner-1"),
      "session-1",
      { contextType: "dm" },
    );
    expect(owner.agentDaemon.sendMessage).toHaveBeenCalledWith(
      "task-active",
      RULE_REQUEST,
      undefined,
      undefined,
      { textProvenance: "user_typed" },
    );

    // A paired contact writing in a DM is someone else: their text is injected.
    const contact = makeFollowUpRouter();
    await (contact.router as Any).forwardToDesktopApp(
      contact.adapter,
      directMessage("contact-1"),
      "session-1",
      { contextType: "dm" },
    );
    expect(contact.agentDaemon.sendMessage).toHaveBeenCalledWith(
      "task-active",
      RULE_REQUEST,
      undefined,
      undefined,
      undefined,
    );
  });

  it("applies the same owner check to /steer", async () => {
    const owner = makeFollowUpRouter();
    await (owner.router as Any).handleSteerCommand(
      owner.adapter,
      directMessage("owner-1"),
      "session-1",
      RULE_REQUEST.split(" "),
    );
    expect(owner.agentDaemon.sendMessage.mock.calls[0][1]).toContain(RULE_REQUEST);
    expect(owner.agentDaemon.sendMessage.mock.calls[0][4]).toEqual({
      textProvenance: "user_typed",
    });

    const contact = makeFollowUpRouter();
    await (contact.router as Any).handleSteerCommand(
      contact.adapter,
      directMessage("contact-1"),
      "session-1",
      RULE_REQUEST.split(" "),
    );
    expect(contact.agentDaemon.sendMessage.mock.calls[0][1]).toContain(RULE_REQUEST);
    expect(contact.agentDaemon.sendMessage.mock.calls[0][4]).toBeUndefined();
  });
});
