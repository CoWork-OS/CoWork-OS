import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { WebRequestContext } from "../../web/WebApplication";
const mailbox = vi.hoisted(() => ({
  getThread: vi.fn(async () => ({
    id: "thread",
    attachments: [{ name: "report.txt", localPath: "/private/report.txt" }],
  })),
  getReplyTargets: vi.fn(async () => [
    {
      handleId: "handle-1",
      channelType: "slack",
      channelId: "channel-1",
      chatId: "chat-1",
      label: "Alex",
    },
  ]),
  previewMissionControlHandoff: vi.fn(async () => ({ threadId: "thread" })),
  listMissionControlHandoffs: vi.fn(async () => []),
  updateCommitmentDetails: vi.fn(),
  updateCommitmentState: vi.fn(),
  generateDraft: vi.fn(),
  reclassifyAccount: vi.fn(),
  retryMailboxAction: vi.fn(),
  extractMailboxAttachmentText: vi.fn(),
  createMailboxRule: vi.fn(),
  deleteMailboxRule: vi.fn(),
  createMailboxSchedule: vi.fn(),
  deleteMailboxSchedule: vi.fn(),
  createMailboxForward: vi.fn(),
  deleteMailboxForward: vi.fn(),
  runMailboxForward: vi.fn(),
  previewMailboxLabelSimilar: vi.fn(),
  createMailboxSavedView: vi.fn(),
  createMissionControlHandoff: vi.fn(),
  upsertMailboxSnippet: vi.fn(async (value: unknown) => value),
  applyAction: vi.fn(),
}));
vi.mock("../../../electron/mailbox/MailboxService", () => ({
  MailboxService: vi.fn(),
  getMailboxServiceInstance: () => mailbox,
}));
import { createBrowserMailboxDefinitions } from "../browser-mailbox-methods";
import { BrowserDesktopRpcService } from "../browser-desktop-rpc";
const context = {
  audience: "control-plane",
  sessionId: "paired",
  operationKey: "mailbox-edit-key",
} as WebRequestContext;

describe("browser mailbox adapter", () => {
  it("returns attachment metadata without exposing host file paths", async () => {
    const service = new BrowserDesktopRpcService(
      createBrowserMailboxDefinitions({} as Database.Database).definitions,
    );
    const method = service.methods()["desktop.getMailboxThread"];
    const result = await method.handler(context, method.validateParams!({ args: ["thread"] }));
    expect(result).toEqual({ id: "thread", attachments: [{ name: "report.txt" }] });
  });
  it("edits a snippet using its existing identifier instead of creating a replacement", async () => {
    const service = new BrowserDesktopRpcService(
      createBrowserMailboxDefinitions({} as Database.Database).definitions,
    );
    const method = service.methods()["desktop.upsertMailboxSnippet"];
    const request = { id: "existing-snippet", shortcut: "thanks", body: "Thank you" };
    await method.handler(context, method.validateParams!({ args: [request] }));
    expect(mailbox.upsertMailboxSnippet).toHaveBeenCalledWith(request);
  });
  it("rejects host paths and unsupported outgoing actions before dispatch", () => {
    const service = new BrowserDesktopRpcService(
      createBrowserMailboxDefinitions({} as Database.Database).definitions,
    );
    const method = service.methods()["desktop.applyMailboxAction"];
    expect(() =>
      method.validateParams!({
        args: [{ type: "send", threadId: "thread", attachmentPath: "/private/file" }],
      }),
    ).toThrow();
    expect(() => method.validateParams!({ args: [{ type: "archive" }] })).toThrow();
    expect(mailbox.applyAction).not.toHaveBeenCalled();
  });

  it("exposes the inbox actions that the shared renderer invokes", () => {
    const definitions = createBrowserMailboxDefinitions({} as Database.Database, {
      sendMessage: vi.fn(),
    }).definitions;
    for (const name of [
      "previewMailboxMissionControlHandoff",
      "listMailboxMissionControlHandoffs",
      "createMailboxMissionControlHandoff",
      "updateMailboxCommitmentDetails",
      "updateMailboxCommitmentState",
      "generateMailboxDraft",
      "reclassifyMailboxAccount",
      "retryMailboxAction",
      "extractMailboxAttachmentText",
      "replyViaChannel",
      "createMailboxRule",
      "deleteMailboxRule",
      "createMailboxSchedule",
      "deleteMailboxSchedule",
      "createMailboxForward",
      "deleteMailboxForward",
      "runMailboxForward",
      "previewMailboxSavedViewSimilar",
      "createMailboxSavedView",
    ]) {
      expect(definitions[name], `${name} is missing`).toBeDefined();
    }
  });

  it("sends a cross-channel reply only to the current matching reply target", async () => {
    const sendMessage = vi.fn(async () => "message-1");
    const service = new BrowserDesktopRpcService(
      createBrowserMailboxDefinitions({} as Database.Database, { sendMessage }).definitions,
    );
    const method = service.methods()["desktop.replyViaChannel"];
    const params = method.validateParams!({
      args: [
        {
          threadId: "thread",
          handleId: "handle-1",
          channelType: "slack",
          message: "Following up",
          parseMode: "text",
        },
      ],
    });
    await method.handler(context, params);
    expect(sendMessage).toHaveBeenCalledWith("slack", "chat-1", "Following up", {
      channelDbId: "channel-1",
      parseMode: "text",
    });

    mailbox.getReplyTargets.mockResolvedValueOnce([]);
    await expect(
      method.handler({ ...context, operationKey: "reply-stale-target" }, params),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
