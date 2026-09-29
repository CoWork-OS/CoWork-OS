import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import type { WebRequestContext } from "../../web/WebApplication";
const mailbox = vi.hoisted(() => ({
  getThread: vi.fn(async () => ({
    id: "thread",
    attachments: [{ name: "report.txt", localPath: "/private/report.txt" }],
  })),
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
});
