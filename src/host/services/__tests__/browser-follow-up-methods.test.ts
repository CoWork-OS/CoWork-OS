import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AgentMessageSendResult, Task, Workspace } from "../../../shared/types";
import type { WebRequestContext } from "../../web/WebApplication";
import {
  createBrowserFollowUpMethods,
  type BrowserFollowUpCommands,
  type BrowserFollowUpSources,
} from "../browser-follow-up-methods";

const workspace = { id: "workspace-1", isTemp: false } as Workspace;
const task = {
  id: "task-1",
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
    sendFollowUp: vi.fn(async (_taskId, _message, messageId) => ({
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
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledWith(
      task.id,
      "Continue from the last result.",
      stableMessageId(context.audience, context.operationKey!),
    );
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
        images: [],
      }),
    ).toThrow();
  });

  it("replays the same request through the durable message identity and conflicts on changed text", async () => {
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

    await methods["task.followUp"].handler(
      context,
      methods["task.followUp"].validateParams!({
        taskId: task.id,
        workspaceId: workspace.id,
        message: "First message",
      }),
    );
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
    expect(dependency.commands.sendFollowUp).toHaveBeenCalledTimes(2);
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
