import { describe, it, expect, vi, afterEach } from "vitest";

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

function createWhatsAppAdapter() {
  return {
    type: "whatsapp",
    status: "connected",
    botUsername: "test-bot",
    onMessage: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue("wa-msg-1"),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as Any;
}

function createChatAdapter(type: string) {
  return {
    type,
    status: "connected",
    botUsername: "test-bot",
    onMessage: vi.fn(),
    onError: vi.fn(),
    onStatusChange: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(`${type}-msg-1`),
    editMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as Any;
}

describe("MessageRouter WhatsApp task updates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("suppresses executor-internal planning chatter", async () => {
    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createWhatsAppAdapter();

    (router as Any).adapters.set("whatsapp", adapter);
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-1", {
      adapter,
      channelId: "wa-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate(
      "task-1",
      "[planning] Using strong model profile for execution plan creation",
    );
    await router.sendTaskUpdate(
      "task-1",
      "Execution strategy active: intent=advice, domain=general, convoMode=hybrid, execMode=plan, answerFirst=true, llmProfileHint=strong",
    );
    await router.sendTaskUpdate(
      "task-1",
      "LLM failover activated: provider=openrouter, model=qwen/qwen3.6-plus:free, previousProvider=azure, reason=fallback",
    );
    await router.sendTaskUpdate("task-1", "Execution prompt built");
    await router.sendTaskUpdate("task-1", "Follow-up prompt built");
    await router.sendTaskUpdate("task-1", "Processing follow-up message");
    await router.sendTaskUpdate(
      "task-1",
      "Answer-first short-circuit active. Skipping deep plan execution and finalizing.",
    );
    await router.sendTaskUpdate("task-1", "execution_run_summary");

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("drops raw step progress instead of narrating executor internals", async () => {
    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createWhatsAppAdapter();

    (router as Any).adapters.set("whatsapp", adapter);
    (router as Any).channelRepo.findById = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-2", {
      adapter,
      channelId: "wa-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate("task-2", "Creating execution plan (model: gpt-5.4)...");
    await router.sendTaskUpdate("task-2", "Starting execution of 10 steps");
    await router.sendTaskUpdate("task-2", "Executing step 3/10: Review repository activity");

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("drops completed-step spam on WhatsApp", async () => {
    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createWhatsAppAdapter();

    (router as Any).adapters.set("whatsapp", adapter);
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-3", {
      adapter,
      channelId: "wa-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate("task-3", "Completed step 2: Review repository activity");
    await router.sendTaskUpdate("task-3", "All steps completed");

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses tool trace chatter and raw tool errors on WhatsApp", async () => {
    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createWhatsAppAdapter();

    (router as Any).adapters.set("whatsapp", adapter);
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-tool-noise", {
      adapter,
      channelId: "wa-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate("task-tool-noise", "Running read_pdf_visual");
    await router.sendTaskUpdate(
      "task-tool-noise",
      'Grep search: "(?m)^\\s*[0-9]{1,3}\\s*$" in .cowork/tmp_sens_et_dieu.txt',
    );
    await router.sendTaskUpdate(
      "task-tool-noise",
      "Glob search: */[Ss]ens_et_Dieu_finale.pdf in .",
    );
    await router.sendTaskUpdate(
      "task-tool-noise",
      "Resuming execution after user input",
    );
    await router.sendTaskUpdate(
      "task-tool-noise",
      "Tool error (read_pdf_visual): p1: Gemini API key not configured. | p2: Gemini API key not configured.",
    );

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("sends compact approval prompts on WhatsApp without command previews", async () => {
    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createWhatsAppAdapter();

    (router as Any).adapters.set("whatsapp", adapter);
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-approval-wa", {
      adapter,
      channelId: "wa-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendApprovalRequest("task-approval-wa", {
      id: "approval-12345678",
      type: "run_command",
      description: "Review the shell command below before approving.",
      details: {
        command: "python3 - <<'PY'\nprint('hello')\nPY",
      },
    });

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    const sent = adapter.sendMessage.mock.calls[0][0].text as string;
    expect(sent).toContain("A shell command needs approval to continue.");
    expect(sent).toContain("/approve approval");
    expect(sent).not.toContain("python3 - <<'PY'");
    expect(sent).not.toContain("Review the shell command below before approving.");
    expect(sent).not.toContain("Details:");
  });

  it("keeps streamed assistant messages for in-between updates", async () => {
    vi.useFakeTimers();

    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createWhatsAppAdapter();

    (router as Any).adapters.set("whatsapp", adapter);
    (router as Any).channelRepo.findById = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "wa-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-4", {
      adapter,
      channelId: "wa-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate("task-4", "I found the root cause. I'm patching it now.", true);

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        text: "I found the root cause. I'm patching it now.",
      }),
    );
  });

  it("uses the final result text directly for channel completion messages", async () => {
    const richSummary = "Almarion,\n\nBu adim icin en dogru sonuc bu.";

    for (const channelType of ["whatsapp", "discord"]) {
      const db = createMockDb();
      const router = new MessageRouter(db, {}, undefined);
      const adapter =
        channelType === "whatsapp"
          ? createWhatsAppAdapter()
          : createChatAdapter(channelType);

      (router as Any).adapters.set(channelType, adapter);
      (router as Any).channelRepo.findById = vi
        .fn()
        .mockReturnValue({ id: `${channelType}-1` });
      (router as Any).channelRepo.findByType = vi
        .fn()
        .mockReturnValue({ id: `${channelType}-1` });
      (router as Any).messageRepo.create = vi.fn();
      (router as Any).maybeSendTaskFeedbackControls = vi.fn().mockResolvedValue(undefined);
      (router as Any).sendTaskArtifacts = vi.fn().mockResolvedValue(undefined);
      (router as Any).pendingTaskResponses.set(`task-complete-${channelType}`, {
        adapter,
        channelId: `${channelType}-1`,
        chatId: "chat-1",
        sessionId: "session-1",
      });

      await router.handleTaskCompletion(`task-complete-${channelType}`, richSummary);

      expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "chat-1",
          text: richSummary,
        }),
      );
    }
  });
});

describe("MessageRouter external channel task updates", () => {
  it("suppresses executor-internal task updates for telegram and discord too", async () => {
    const db = createMockDb();

    for (const channelType of ["telegram", "discord", "slack", "teams"]) {
      const router = new MessageRouter(db, {}, undefined);
      const adapter = createChatAdapter(channelType);

      (router as Any).adapters.set(channelType, adapter);
      (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: `${channelType}-1` });
      (router as Any).messageRepo.create = vi.fn();
      (router as Any).pendingTaskResponses.set(`task-${channelType}`, {
        adapter,
        channelId: `${channelType}-1`,
        chatId: "chat-1",
        sessionId: "session-1",
      });

      await router.sendTaskUpdate(`task-${channelType}`, "LLM route selected: provider=azure, profile=cheap, source=profile_model, model=gpt-5.4-mini");
      await router.sendTaskUpdate(`task-${channelType}`, "Creating execution plan (model: gpt-5.4)...");
      await router.sendTaskUpdate(`task-${channelType}`, "Executing step 1/3: Inspect the codebase");
      await router.sendTaskUpdate(
        `task-${channelType}`,
        "Execution strategy active: intent=advice, domain=general, convoMode=hybrid, execMode=plan, answerFirst=true, llmProfileHint=strong",
      );
      await router.sendTaskUpdate(`task-${channelType}`, "Follow-up prompt built");
      await router.sendTaskUpdate(`task-${channelType}`, "Processing follow-up message");
      await router.sendTaskUpdate(
        `task-${channelType}`,
        "Answer-first short-circuit active. Skipping deep plan execution and finalizing.",
      );
      await router.sendTaskUpdate(`task-${channelType}`, "execution_run_summary");

      expect(adapter.sendMessage).not.toHaveBeenCalled();
    }
  });

  it("relays curated progress updates into Slack when enabled", async () => {
    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createChatAdapter("slack");

    (router as Any).adapters.set("slack", adapter);
    (router as Any).channelRepo.findById = vi.fn().mockReturnValue({
      id: "slack-1",
      config: { progressRelayMode: "curated" },
    });
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "slack-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-slack-curated", {
      adapter,
      channelId: "slack-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate("task-slack-curated", "Creating execution plan (model: gpt-5.4)...");
    await router.sendTaskUpdate("task-slack-curated", "Executing step 1/3: Inspect the codebase");
    await router.sendTaskUpdate("task-slack-curated", "Completed step 1: Inspect the codebase");

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        text: "Planning the work.",
      }),
    );
    expect(adapter.editMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      "slack-msg-1",
      "Inspecting the codebase",
    );
    expect(adapter.editMessage).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      "slack-msg-1",
      "Completed: Inspect the codebase",
    );
  });

  it("keeps streamed assistant text as regular Slack output even in curated mode", async () => {
    vi.useFakeTimers();

    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createChatAdapter("slack");

    (router as Any).adapters.set("slack", adapter);
    (router as Any).channelRepo.findById = vi.fn().mockReturnValue({
      id: "slack-1",
      config: { progressRelayMode: "curated" },
    });
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "slack-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-slack-stream", {
      adapter,
      channelId: "slack-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate("task-slack-stream", "I found the root cause. Applying the fix now.", true);

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        text: "I found the root cause. Applying the fix now.",
      }),
    );
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it("keeps streamed assistant messages for discord", async () => {
    vi.useFakeTimers();

    const db = createMockDb();
    const router = new MessageRouter(db, {}, undefined);
    const adapter = createChatAdapter("discord");

    (router as Any).adapters.set("discord", adapter);
    (router as Any).channelRepo.findById = vi.fn().mockReturnValue({ id: "discord-1" });
    (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: "discord-1" });
    (router as Any).messageRepo.create = vi.fn();
    (router as Any).pendingTaskResponses.set("task-discord", {
      adapter,
      channelId: "discord-1",
      chatId: "chat-1",
      sessionId: "session-1",
    });

    await router.sendTaskUpdate("task-discord", "I found the issue. Applying the fix now.", true);

    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();
    await Promise.resolve();

    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: "chat-1",
        text: "I found the issue. Applying the fix now.",
      }),
    );
  });

  it("suppresses tool trace chatter for telegram and discord too", async () => {
    const db = createMockDb();

    for (const channelType of ["telegram", "discord"]) {
      const router = new MessageRouter(db, {}, undefined);
      const adapter = createChatAdapter(channelType);

      (router as Any).adapters.set(channelType, adapter);
      (router as Any).channelRepo.findByType = vi.fn().mockReturnValue({ id: `${channelType}-1` });
      (router as Any).messageRepo.create = vi.fn();
      (router as Any).pendingTaskResponses.set(`task-noise-${channelType}`, {
        adapter,
        channelId: `${channelType}-1`,
        chatId: "chat-1",
        sessionId: "session-1",
      });

      await router.sendTaskUpdate(`task-noise-${channelType}`, "Running run_command");
      await router.sendTaskUpdate(
        `task-noise-${channelType}`,
        "Resuming execution after user input",
      );
      await router.sendTaskUpdate(`task-noise-${channelType}`, "Glob search: */*.pdf in .");
      await router.sendTaskUpdate(
        `task-noise-${channelType}`,
        "Tool error (run_command): permission denied",
      );

      expect(adapter.sendMessage).not.toHaveBeenCalled();
    }
  });
});
