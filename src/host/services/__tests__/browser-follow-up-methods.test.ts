import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessageSendResult, Task, TaskEvent, Workspace } from "../../../shared/types";
import type { WebRequestContext } from "../../web/WebApplication";
import { createQuotedAssistantMessage } from "../../../renderer/components/MainContent/message-ui";
import {
  createBrowserFollowUpMethods,
  type BrowserFollowUpCommands,
  type BrowserFollowUpSources,
} from "../browser-follow-up-methods";

const workspace = {
  id: "workspace-1",
  isTemp: false,
  permissions: { read: true, write: true, delete: false, network: true, shell: false },
} as Workspace;
const task = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  workspaceId: workspace.id,
  title: "Review the project",
  status: "completed",
  prompt: "private task prompt",
} as Task;
const context = {
  audience: "control-plane",
  identity: {
    installationId: "installation-1",
    profileId: "profile-1",
    generation: "generation-1",
    runtime: "node" as const,
    platform: "linux" as const,
    appVersion: "1.0.0",
  },
  sessionId: "session-1",
  operationKey: "follow-up-12345678",
} satisfies WebRequestContext;

function commands(): BrowserFollowUpCommands {
  return {
    sendFollowUp: vi.fn(async (_taskId, _message, messageId, _options) => ({
      queued: false,
      messageId,
      deliveryMode: "follow_up",
      deliveryStatus: "accepted",
      acceptedAt: 1710000000000,
    })),
    getFollowUpReceipt: vi.fn(async (_taskId, messageId) => ({
      queued: false,
      duplicate: true,
      messageId,
      deliveryMode: "follow_up",
      deliveryStatus: "accepted",
      acceptedAt: 1710000000000,
    })),
  };
}

function sources(overrides: Partial<BrowserFollowUpSources> = {}): BrowserFollowUpSources & {
  commands: BrowserFollowUpCommands;
} {
  const taskCommands = commands();
  return {
    getTask: vi.fn(async (taskId: string) => (taskId === task.id ? task : null)),
    getWorkspace: vi.fn(async (workspaceId: string) =>
      workspaceId === workspace.id ? workspace : null,
    ),
    commands: taskCommands,
    ...overrides,
  };
}

function stableMessageId(audience: string, operationKey: string): string {
  const digest = createHash("sha256").update(operationKey).digest("hex");
  return `web:${audience}:${digest}`;
}

describe("browser task follow-up methods", () => {
  it("admits a scoped text-only follow-up and returns only its durable receipt", async () => {
    const dependency = sources();
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "  Continue from the last result.  ",
    });

    await expect(methods["task.followUp"].handler(context, params)).resolves.toEqual({
      taskId: task.id,
      messageId: stableMessageId(context.audience, context.operationKey!),
      found: true,
      state: "admitted",
      deliveryStatus: "accepted",
      acceptedAt: 1710000000000,
    });
    const sendCall = vi.mocked(dependency.commands.sendFollowUp).mock.calls[0]!;
    expect(sendCall.slice(0, 4)).toEqual([
      task.id,
      "Continue from the last result.",
      stableMessageId(context.audience, context.operationKey!),
      {},
    ]);
    expect(sendCall[4]).toBeUndefined();
    expect(sendCall[5]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.stringify(
        await methods["task.followUp.receipt"].handler(context, {
          taskId: task.id,
          workspaceId: workspace.id,
          operationKey: context.operationKey,
        }),
      ),
    ).not.toContain("private task prompt");
  });

  it("rejects a task outside the requested workspace and unsupported payload fields", async () => {
    const dependency = sources();
    const methods = createBrowserFollowUpMethods(dependency);
    await expect(
      methods["task.followUp"].handler(
        context,
        methods["task.followUp"].validateParams!({
          taskId: task.id,
          workspaceId: "workspace-other",
          message: "Continue",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(dependency.commands.sendFollowUp).not.toHaveBeenCalled();
    expect(() =>
      methods["task.followUp"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        message: "Continue",
        images: [
          {
            relativePath: "/tmp/diagram.png",
            mimeType: "image/png",
            filename: "diagram.png",
            sizeBytes: 8,
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts safe composer modes and access profiles, and binds them to the operation identity", async () => {
    const dependency = sources();
    const methods = createBrowserFollowUpMethods(dependency);
    const request = {
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Continue with a plan.",
      interactionMode: { mode: "smart", executionOverride: "plan" },
      accessProfileId: "ask_for_approval",
      permissionMode: "plan",
      shellAccess: false,
    };
    await methods["task.followUp"].handler(
      context,
      methods["task.followUp"].validateParams!(request),
    );
    const sendCall = vi.mocked(dependency.commands.sendFollowUp).mock.calls[0]!;
    expect(sendCall.slice(0, 4)).toEqual([
      task.id,
      request.message,
      stableMessageId(context.audience, context.operationKey!),
      {
        interactionMode: request.interactionMode,
        accessProfileId: "ask_for_approval",
        permissionMode: "plan",
        shellAccess: false,
      },
    ]);
    expect(sendCall[5]).toMatch(/^[a-f0-9]{64}$/);

    await expect(
      methods["task.followUp"].handler(
        context,
        methods["task.followUp"].validateParams!({
          ...request,
          interactionMode: { mode: "chat" },
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("rejects unavailable profiles and permission or shell options that broaden authority", () => {
    const methods = createBrowserFollowUpMethods(sources());
    const base = { taskId: task.id, workspaceId: workspace.id, message: "Continue" };
    for (const options of [
      { accessProfileId: "missing_profile" },
      { permissionMode: "bypass_permissions" },
      { permissionMode: "dont_ask" },
      { shellAccess: true },
      { interactionMode: { mode: "unknown" } },
    ]) {
      expect(() => methods["task.followUp"].validateParams!({ ...base, ...options })).toThrow();
    }
  });

  it("forwards a bounded quote, actual-schema integration mention, and expected turn guard", async () => {
    const dependency = sources();
    const methods = createBrowserFollowUpMethods(dependency);
    const mention = {
      id: "provider:search",
      label: "Search",
      source: "mcp",
      providerKey: "provider",
      iconKey: "search",
      tools: ["search"],
      promptHint: "Use search for recent information.",
    } as const;
    const request = {
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Continue from this answer.",
      expectedTurnId: "  turn-42  ",
      quotedAssistantMessage: {
        message: "Previously verified text",
      },
      integrationMentions: [mention],
    };
    const params = methods["task.followUp"].validateParams!(request);
    await methods["task.followUp"].handler(context, params);

    const sendCall = vi.mocked(dependency.commands.sendFollowUp).mock.calls[0]!;
    expect(sendCall.slice(0, 4)).toEqual([
      task.id,
      request.message,
      stableMessageId(context.audience, context.operationKey!),
      {
        expectedTurnId: "turn-42",
        quotedAssistantMessage: request.quotedAssistantMessage,
        integrationMentions: [mention],
      },
    ]);
    expect(sendCall[4]).toBeUndefined();
    expect(sendCall[5]).toMatch(/^[a-f0-9]{64}$/);
    const receipt = await methods["task.followUp"].handler(context, params);
    expect(JSON.stringify(receipt)).not.toContain("Previously verified text");
    expect(JSON.stringify(receipt)).not.toContain(mention.promptHint);
  });

  it("rejects malformed mention records and oversized optimistic turn IDs", () => {
    const methods = createBrowserFollowUpMethods(sources());
    const base = { taskId: task.id, workspaceId: workspace.id, message: "Continue" };
    const mention = {
      id: "provider:search",
      label: "Search",
      source: "mcp",
      providerKey: "provider",
      iconKey: "search",
      tools: ["search"],
      promptHint: "Use search.",
    };
    expect(() =>
      methods["task.followUp"].validateParams!({
        ...base,
        integrationMentions: [{ ...mention, authority: "bypass" }],
      }),
    ).toThrow();
    expect(() =>
      methods["task.followUp"].validateParams!({ ...base, expectedTurnId: "x".repeat(201) }),
    ).toThrow();
  });

  it("resolves workspace-relative media into frozen captures and fingerprints their identity", async () => {
    const descriptor = {
      relativePath: "artifacts/chart.png",
      mimeType: "image/png",
      filename: "chart.png",
      sizeBytes: 8,
    } as const;
    const captured = {
      ...descriptor,
      mimeType: "image/png" as const,
      sha256: "ab".repeat(32),
      identity: { dev: 3, ino: 4, size: 8, mtimeMs: 1710000000000 },
      bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    };
    const prepareFollowUpMedia = vi.fn(async () => [captured]);
    const dependency = sources({ prepareFollowUpMedia });
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Review this chart.",
      images: [descriptor],
    });

    await methods["task.followUp"].handler(context, params);
    expect(prepareFollowUpMedia).toHaveBeenCalledWith(context, workspace.id, [descriptor]);
    const sendCall = vi.mocked(dependency.commands.sendFollowUp).mock.calls[0]!;
    expect(sendCall[4]).toEqual([captured]);
    expect(sendCall[5]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(await methods["task.followUp"].handler(context, params))).not.toContain(
      captured.sha256,
    );
  });

  it("changes the durable request fingerprint when frozen media bytes change after restart", async () => {
    const descriptor = {
      relativePath: "artifacts/chart.png",
      mimeType: "image/png",
      filename: "chart.png",
      sizeBytes: 8,
    } as const;
    const request = {
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Review this chart.",
      images: [descriptor],
    };
    const sendWithCapture = async (captureHash: string) => {
      const prepareFollowUpMedia = vi.fn(async () => [
        {
          ...descriptor,
          mimeType: "image/png" as const,
          sha256: captureHash,
          identity: { dev: 3, ino: 4, size: 8, mtimeMs: 1710000000000 },
          bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        },
      ]);
      const dependency = sources({ prepareFollowUpMedia });
      const methods = createBrowserFollowUpMethods(dependency);
      await methods["task.followUp"].handler(
        context,
        methods["task.followUp"].validateParams!(request),
      );
      return vi.mocked(dependency.commands.sendFollowUp).mock.calls[0]![5];
    };

    const originalFingerprint = await sendWithCapture("cd".repeat(32));
    const changedFingerprint = await sendWithCapture("ef".repeat(32));
    expect(originalFingerprint).not.toBe(changedFingerprint);
  });

  it("verifies event-backed quotes against an assistant event in the same task", async () => {
    const assistantEvent = {
      id: "event-quote",
      eventId: "event-quote",
      taskId: task.id,
      timestamp: 1710000000000,
      type: "assistant_message",
      legacyType: "assistant_message",
      payload: { message: "The task result is ready." },
      schemaVersion: 2,
    } as TaskEvent;
    const getQuotedAssistantEvent = vi.fn(async (taskId: string, eventId: string) =>
      taskId === assistantEvent.taskId && eventId === assistantEvent.eventId
        ? assistantEvent
        : null,
    );
    const dependency = sources({ getQuotedAssistantEvent });
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Explain this.",
      quotedAssistantMessage: {
        eventId: assistantEvent.eventId,
        message: "The task result is ready.",
      },
    });

    await methods["task.followUp"].handler(context, params);
    expect(getQuotedAssistantEvent).toHaveBeenCalledWith(task.id, assistantEvent.eventId);
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("matches citation-formatted visible text after shared assistant cleanup", async () => {
    const assistantEvent = {
      id: "event-citations",
      eventId: "event-citations",
      taskId: task.id,
      timestamp: 1710000000000,
      type: "assistant_message",
      payload: {
        message:
          "[[speak]]Answer is supported. Sources: [1] https://one.example | [2] https://two.example <tool_call>private tool body</tool_call>[[/speak]]",
      },
      schemaVersion: 2,
    } as TaskEvent;
    const dependency = sources({ getQuotedAssistantEvent: vi.fn(async () => assistantEvent) });
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Continue.",
      quotedAssistantMessage: {
        eventId: assistantEvent.eventId,
        message:
          "Answer is supported. Sources: [1] [https://one.example](https://one.example)  \n[2] [https://two.example](https://two.example)",
      },
    });

    await expect(methods["task.followUp"].handler(context, params)).resolves.toMatchObject({
      state: "admitted",
    });
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("accepts quote text produced by the renderer for fenced Markdown", async () => {
    const raw = "```markdown\n# Deployment\nThe task result is ready.\n\n1. Build\n2. Verify\n```";
    const quote = createQuotedAssistantMessage(raw, "event-markdown", task.id);
    expect(quote).not.toBeNull();
    const assistantEvent = {
      id: "event-markdown",
      eventId: "event-markdown",
      taskId: task.id,
      timestamp: 1710000000000,
      type: "assistant_message",
      payload: { message: raw },
      schemaVersion: 2,
    } as TaskEvent;
    const dependency = sources({ getQuotedAssistantEvent: vi.fn(async () => assistantEvent) });
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Continue.",
      quotedAssistantMessage: quote,
    });

    await expect(methods["task.followUp"].handler(context, params)).resolves.toMatchObject({
      state: "admitted",
    });
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("accepts renderer-linked JSON host paths and protected glob tokens", async () => {
    const raw =
      '{"path":"/Users/mesut/Downloads/app/cowork/src/renderer/App.tsx"}\nThe matching files are **/src/*.tsx.';
    const quote = createQuotedAssistantMessage(raw, "event-paths", task.id);
    expect(quote).not.toBeNull();
    const assistantEvent = {
      id: "event-paths",
      eventId: "event-paths",
      taskId: task.id,
      timestamp: 1710000000000,
      type: "assistant_message",
      payload: { message: raw },
      schemaVersion: 2,
    } as TaskEvent;
    const dependency = sources({ getQuotedAssistantEvent: vi.fn(async () => assistantEvent) });
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Explain the matches.",
      quotedAssistantMessage: quote,
    });

    await expect(methods["task.followUp"].handler(context, params)).resolves.toMatchObject({
      state: "admitted",
    });
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("rejects fabricated, cross-task, and non-assistant event quotes", async () => {
    const assistantEvent = {
      id: "event-quote",
      eventId: "event-quote",
      taskId: task.id,
      timestamp: 1710000000000,
      type: "assistant_message",
      payload: { message: "The task result is ready." },
      schemaVersion: 2,
    } as TaskEvent;
    const methodsFor = (event: TaskEvent | null) => {
      const dependency = sources({
        getQuotedAssistantEvent: vi.fn(async () => event),
      });
      return { dependency, methods: createBrowserFollowUpMethods(dependency) };
    };
    const cases: Array<[TaskEvent | null, string]> = [
      [assistantEvent, "A fabricated quote."],
      [{ ...assistantEvent, eventId: "event-other" }, "The task result is ready."],
      [{ ...assistantEvent, taskId: "task-other" }, "The task result is ready."],
      [{ ...assistantEvent, type: "user_message" }, "The task result is ready."],
      [
        { ...assistantEvent, payload: { message: "The task result is ready.", internal: true } },
        "The task result is ready.",
      ],
    ];
    for (const [event, message] of cases) {
      const { dependency, methods } = methodsFor(event);
      const params = methods["task.followUp"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        message: "Explain this.",
        quotedAssistantMessage: {
          eventId: "event-quote",
          message,
        },
      });
      await expect(methods["task.followUp"].handler(context, params)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(dependency.commands.sendFollowUp).not.toHaveBeenCalled();
    }
  });

  it("binds the optimistic turn guard and quote details to the operation key", async () => {
    const dependency = sources();
    const methods = createBrowserFollowUpMethods(dependency);
    const base = {
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Continue.",
      expectedTurnId: "turn-1",
      quotedAssistantMessage: { message: "Quoted answer" },
    };
    await methods["task.followUp"].handler(context, methods["task.followUp"].validateParams!(base));
    await expect(
      methods["task.followUp"].handler(
        context,
        methods["task.followUp"].validateParams!({ ...base, expectedTurnId: "turn-2" }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("replays one accepted request and conflicts when its text changes under the same key", async () => {
    const dependency = sources();
    const durable = new Map<string, { taskId: string; message: string }>();
    vi.mocked(dependency.commands.sendFollowUp).mockImplementation(
      async (taskId, message, messageId) => {
        const existing = durable.get(messageId);
        if (existing && existing.message !== message) {
          throw new Error(`Message ID ${messageId} was already used for different content.`);
        }
        if (!existing) durable.set(messageId, { taskId, message });
        return {
          queued: false,
          messageId,
          deliveryMode: "follow_up",
          deliveryStatus: "accepted",
        };
      },
    );
    vi.mocked(dependency.commands.getFollowUpReceipt).mockImplementation(
      async (_taskId, messageId) =>
        durable.has(messageId)
          ? {
              queued: false,
              messageId,
              deliveryMode: "follow_up",
              deliveryStatus: "accepted",
            }
          : null,
    );
    const methods = createBrowserFollowUpMethods(dependency);

    const first = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "First message",
    });
    await methods["task.followUp"].handler(context, first);
    await methods["task.followUp"].handler(context, first);
    await expect(
      methods["task.followUp"].handler(
        context,
        methods["task.followUp"].validateParams!({
          taskId: task.id,
          workspaceId: workspace.id,
          message: "Changed message",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("conflicts on changed quote, options, or media after the host restarts", async () => {
    const dependency = sources({
      prepareFollowUpMedia: vi.fn(async (_context, _workspaceId, descriptors) =>
        descriptors.map((descriptor) => ({
          ...descriptor,
          bytes: Buffer.from("image-bytes"),
          sha256: "a".repeat(64),
          identity: { dev: 1, ino: 2, size: descriptor.sizeBytes, mtimeMs: 3 },
        })),
      ),
    });
    let storedFingerprint: string | undefined;
    vi.mocked(dependency.commands.sendFollowUp).mockImplementation(
      async (_taskId, _message, messageId, _options, _attachments, requestFingerprint) => {
        if (storedFingerprint && storedFingerprint !== requestFingerprint) {
          throw new Error(`Message ID ${messageId} was already used for a different request.`);
        }
        storedFingerprint = requestFingerprint;
        return {
          queued: false,
          messageId,
          deliveryMode: "follow_up",
          deliveryStatus: "accepted",
        };
      },
    );
    const base = {
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Continue the review.",
      expectedTurnId: "turn-1",
      quotedAssistantMessage: { message: "Earlier assistant context" },
    };
    const firstHost = createBrowserFollowUpMethods(dependency);
    await firstHost["task.followUp"].handler(
      context,
      firstHost["task.followUp"].validateParams!(base),
    );

    const changedRequests = [
      { ...base, expectedTurnId: "turn-2" },
      { ...base, quotedAssistantMessage: { message: "Different assistant context" } },
      {
        ...base,
        images: [
          {
            relativePath: "assets/diagram.png",
            mimeType: "image/png",
            filename: "diagram.png",
            sizeBytes: 12,
          },
        ],
      },
    ];
    for (const changedRequest of changedRequests) {
      // A new factory instance models a host restart: only the native durable
      // request fingerprint can detect changed input under the same key.
      const restartedHost = createBrowserFollowUpMethods(dependency);
      await expect(
        restartedHost["task.followUp"].handler(
          context,
          restartedHost["task.followUp"].validateParams!(changedRequest),
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(4);
    // Conflicts are classified before receipt reconciliation; a changed request
    // must not be presented as the original accepted receipt.
    expect(dependency.commands.getFollowUpReceipt).toHaveBeenCalledTimes(1);
  });

  it("rechecks captured media before replaying a same-host cached operation", async () => {
    let capture = 0;
    const dependency = sources({
      prepareFollowUpMedia: vi.fn(async (_context, _workspaceId, descriptors) =>
        descriptors.map((descriptor) => {
          capture += 1;
          return {
            ...descriptor,
            bytes: Buffer.alloc(descriptor.sizeBytes, capture),
            sha256: capture === 1 ? "a".repeat(64) : "b".repeat(64),
            identity: { dev: 1, ino: 2, size: descriptor.sizeBytes, mtimeMs: 3 },
          };
        }),
      ),
    });
    const methods = createBrowserFollowUpMethods(dependency);
    const request = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Compare this image.",
      images: [
        {
          relativePath: "assets/diagram.png",
          mimeType: "image/png",
          filename: "diagram.png",
          sizeBytes: 8,
        },
      ],
    });

    await methods["task.followUp"].handler(context, request);
    await expect(methods["task.followUp"].handler(context, request)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(dependency.prepareFollowUpMedia).toHaveBeenCalledTimes(2);
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent uses of one key and rejects a changed concurrent request", async () => {
    const dependency = sources();
    let resolveAdmission!: (value: AgentMessageSendResult) => void;
    vi.mocked(dependency.commands.sendFollowUp).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAdmission = resolve;
      }),
    );
    const methods = createBrowserFollowUpMethods(dependency);
    const firstParams = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Same message",
    });
    const first = methods["task.followUp"].handler(context, firstParams);
    await vi.waitFor(() => expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1));
    const duplicate = methods["task.followUp"].handler(context, firstParams);
    await expect(
      methods["task.followUp"].handler(
        context,
        methods["task.followUp"].validateParams!({
          taskId: task.id,
          workspaceId: workspace.id,
          message: "Different message",
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    resolveAdmission({
      queued: false,
      messageId: stableMessageId(context.audience, context.operationKey!),
      deliveryMode: "follow_up",
      deliveryStatus: "accepted",
    });
    await Promise.all([first, duplicate]);
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(1);
  });

  it("turns an uncommitted stale-turn rejection into a definitive stale state", async () => {
    const dependency = sources();
    const staleTurn = Object.assign(new Error("Expected turn is stale."), { code: "STALE_TURN" });
    vi.mocked(dependency.commands.sendFollowUp).mockRejectedValueOnce(staleTurn);
    vi.mocked(dependency.commands.getFollowUpReceipt).mockResolvedValueOnce(null);
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      message: "Continue from the latest turn.",
      expectedTurnId: "turn-stale",
    });

    await expect(methods["task.followUp"].handler(context, params)).rejects.toMatchObject({
      code: "STALE_STATE",
      statusCode: 409,
      retryable: false,
    });
    expect(dependency.commands.getFollowUpReceipt).toHaveBeenCalledWith(
      task.id,
      stableMessageId(context.audience, context.operationKey!),
    );

    await expect(methods["task.followUp"].handler(context, params)).resolves.toMatchObject({
      state: "admitted",
    });
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(2);
  });

  it("returns exact lookup as admitted, pending, or unavailable without exposing text or completion", async () => {
    const dependency = sources();
    const methods = createBrowserFollowUpMethods(dependency);
    const params = methods["task.followUp.receipt"].validateParams!({
      taskId: task.id,
      workspaceId: workspace.id,
      operationKey: context.operationKey,
    });

    vi.mocked(dependency.commands.getFollowUpReceipt).mockResolvedValueOnce({
      queued: false,
      messageId: stableMessageId(context.audience, context.operationKey!),
      deliveryMode: "follow_up",
      deliveryStatus: "delivered",
      acceptedAt: 1710000000000,
      deliveredAt: 1710000005000,
    });
    const admitted = await methods["task.followUp.receipt"].handler(context, params);
    expect(admitted).toMatchObject({ state: "admitted", deliveryStatus: "accepted" });
    expect(admitted).not.toHaveProperty("deliveredAt");
    expect(admitted).not.toHaveProperty("message");

    vi.mocked(dependency.commands.getFollowUpReceipt).mockResolvedValueOnce({
      queued: true,
      messageId: stableMessageId(context.audience, context.operationKey!),
      deliveryMode: "follow_up",
      deliveryStatus: "started",
      queuedAt: 1710000000000,
      startedAt: 1710000001000,
    });
    const pending = await methods["task.followUp.receipt"].handler(context, params);
    expect(pending).toMatchObject({ state: "pending", deliveryStatus: "started" });

    vi.mocked(dependency.commands.getFollowUpReceipt).mockResolvedValueOnce(null);
    await expect(methods["task.followUp.receipt"].handler(context, params)).resolves.toMatchObject({
      found: false,
      state: "unavailable",
    });
  });
});
