import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cron", () => ({
  getCronService: vi.fn().mockReturnValue(null),
}));

const gmailRequestMock = vi.fn();

vi.mock("../../utils/gmail-api", () => ({
  gmailRequest: (...args: unknown[]) => gmailRequestMock(...args),
}));

vi.mock("../../settings/google-workspace-manager", () => ({
  GoogleWorkspaceSettingsManager: {
    loadSettings: vi.fn(() => ({
      enabled: true,
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    })),
  },
}));

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("MailboxForwardingService", () => {
  let db: import("better-sqlite3").Database;

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
    db = new Database(":memory:");
    MailboxAutomationRegistry.reset();
    MailboxAutomationRegistry.configure({
      db,
      resolveDefaultWorkspaceId: () => "ws-default",
      triggerService: null,
    });
    gmailRequestMock.mockReset();
  });

  afterEach(async () => {
    const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
    MailboxAutomationRegistry.reset();
    db.close();
  });

  it("runs a dry-run forwarding automation and labels the thread as candidate", async () => {
    const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
    const { MailboxForwardingService } = await import("../MailboxForwardingService");

    const created = MailboxAutomationRegistry.createForward({
      name: "Forward vendor invoices",
      schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
      targetEmail: "ops@example.com",
      allowedSenders: ["billing@vendor.com"],
      allowedDomains: [],
      attachmentExtensions: ["pdf"],
      dryRun: true,
    });

    let createdLabelCount = 0;
    const modifiedThreadCalls: Array<Record<string, unknown>> = [];

    gmailRequestMock.mockImplementation(
      async (_settings: unknown, options: { path: string; method: string; body?: Any }) => {
        if (options.path === "/users/me/labels" && options.method === "GET") {
          return { status: 200, data: { labels: [] } };
        }
        if (options.path === "/users/me/labels" && options.method === "POST") {
          createdLabelCount += 1;
          return { status: 200, data: { id: `label-${createdLabelCount}` } };
        }
        if (options.path === "/users/me/messages" && options.method === "GET") {
          return { status: 200, data: { messages: [{ id: "msg-1", threadId: "thread-1" }] } };
        }
        if (options.path === "/users/me/threads/thread-1" && options.method === "GET") {
          return {
            status: 200,
            data: {
              id: "thread-1",
              messages: [
                {
                  id: "msg-1",
                  threadId: "thread-1",
                  internalDate: Date.now(),
                  labelIds: ["INBOX"],
                  payload: {
                    headers: [
                      { name: "From", value: "Vendor Billing <billing@vendor.com>" },
                      { name: "Subject", value: "Invoice April" },
                    ],
                    parts: [
                      {
                        mimeType: "text/plain",
                        body: { data: Buffer.from("Invoice attached").toString("base64url") },
                      },
                      {
                        filename: "invoice-april.pdf",
                        mimeType: "application/pdf",
                        body: { data: Buffer.from("fake-pdf").toString("base64url") },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        if (options.path === "/users/me/threads/thread-1/modify" && options.method === "POST") {
          modifiedThreadCalls.push(options.body || {});
          return { status: 200, data: {} };
        }
        throw new Error(`Unhandled gmailRequest call: ${options.method} ${options.path}`);
      },
    );

    const service = new MailboxForwardingService({ db });
    const summary = await service.runNow(created.id);

    expect(summary).toContain("Dry run matched 1 message");
    expect(createdLabelCount).toBe(3);
    expect(modifiedThreadCalls).toHaveLength(1);
    expect(modifiedThreadCalls[0]).toMatchObject({
      addLabelIds: ["label-3"],
    });

    const refreshed = MailboxAutomationRegistry.listAutomations({ workspaceId: "ws-default" }).find(
      (item) => item.id === created.id,
    );
    expect(refreshed?.latestOutcome).toContain("Dry run matched 1 message");
  });

  it("scopes automations created from a thread to the Gmail provider thread id", async () => {
    const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
    const { MailboxForwardingService } = await import("../MailboxForwardingService");

    const created = MailboxAutomationRegistry.createForward({
      name: "Forward one thread only",
      threadId: "gmail-thread:alpha",
      providerThreadId: "provider-thread-42",
      schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
      targetEmail: "ops@example.com",
      allowedSenders: ["billing@vendor.com"],
      allowedDomains: [],
      attachmentExtensions: ["pdf"],
      dryRun: true,
    });

    gmailRequestMock.mockImplementation(
      async (_settings: unknown, options: { path: string; method: string; body?: Any }) => {
        if (options.path === "/users/me/labels" && options.method === "GET") {
          return { status: 200, data: { labels: [] } };
        }
        if (options.path === "/users/me/labels" && options.method === "POST") {
          return { status: 200, data: { id: `label-${Math.random()}` } };
        }
        if (options.path === "/users/me/messages" && options.method === "GET") {
          throw new Error(
            "Mailbox-wide message search should not run for provider-thread scoped automations",
          );
        }
        if (options.path === "/users/me/threads/provider-thread-42" && options.method === "GET") {
          return {
            status: 200,
            data: {
              id: "provider-thread-42",
              messages: [
                {
                  id: "msg-thread-only",
                  threadId: "provider-thread-42",
                  internalDate: Date.now(),
                  labelIds: ["INBOX"],
                  payload: {
                    headers: [
                      { name: "From", value: "Vendor Billing <billing@vendor.com>" },
                      { name: "Subject", value: "Thread scoped invoice" },
                    ],
                    parts: [
                      {
                        mimeType: "text/plain",
                        body: { data: Buffer.from("Invoice attached").toString("base64url") },
                      },
                      {
                        filename: "thread-only.pdf",
                        mimeType: "application/pdf",
                        body: { data: Buffer.from("fake-pdf").toString("base64url") },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        if (
          options.path === "/users/me/threads/provider-thread-42/modify" &&
          options.method === "POST"
        ) {
          return { status: 200, data: {} };
        }
        throw new Error(`Unhandled gmailRequest call: ${options.method} ${options.path}`);
      },
    );

    const service = new MailboxForwardingService({ db });
    const summary = await service.runNow(created.id);

    expect(summary).toContain("Dry run matched 1 message");
  });

  it("uses the last successful scan watermark instead of now-minus-lookback after downtime", async () => {
    const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
    const { MailboxForwardingService } = await import("../MailboxForwardingService");

    let currentTime = Date.parse("2026-04-20T12:00:00.000Z");
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => currentTime);

    const created = MailboxAutomationRegistry.createForward({
      name: "Forward invoices reliably",
      schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
      targetEmail: "ops@example.com",
      allowedSenders: ["billing@vendor.com"],
      allowedDomains: [],
      attachmentExtensions: ["pdf"],
      dryRun: false,
      backfillDays: 30,
      lookbackMinutes: 20,
    });

    const messageQueries: string[] = [];
    let sendCount = 0;

    gmailRequestMock.mockImplementation(
      async (
        _settings: unknown,
        options: { path: string; method: string; body?: Any; query?: Record<string, unknown> },
      ) => {
        if (options.path === "/users/me/labels" && options.method === "GET") {
          return { status: 200, data: { labels: [] } };
        }
        if (options.path === "/users/me/labels" && options.method === "POST") {
          return { status: 200, data: { id: `label-${Math.random()}` } };
        }
        if (options.path === "/users/me/messages" && options.method === "GET") {
          messageQueries.push(String(options.query?.q || ""));
          if (messageQueries.length === 1) {
            return { status: 200, data: { messages: [{ id: "msg-1", threadId: "thread-1" }] } };
          }
          return { status: 200, data: { messages: [] } };
        }
        if (options.path === "/users/me/threads/thread-1" && options.method === "GET") {
          return {
            status: 200,
            data: {
              id: "thread-1",
              messages: [
                {
                  id: "msg-1",
                  threadId: "thread-1",
                  internalDate: Date.now(),
                  labelIds: ["INBOX"],
                  payload: {
                    headers: [
                      { name: "From", value: "Vendor Billing <billing@vendor.com>" },
                      { name: "Subject", value: "Invoice April" },
                    ],
                    parts: [
                      {
                        mimeType: "text/plain",
                        body: { data: Buffer.from("Invoice attached").toString("base64url") },
                      },
                      {
                        filename: "invoice-april.pdf",
                        mimeType: "application/pdf",
                        body: { data: Buffer.from("fake-pdf").toString("base64url") },
                      },
                    ],
                  },
                },
              ],
            },
          };
        }
        if (options.path === "/users/me/threads/thread-1/modify" && options.method === "POST") {
          return { status: 200, data: {} };
        }
        if (options.path === "/users/me/messages/send" && options.method === "POST") {
          sendCount += 1;
          return { status: 200, data: { id: `sent-${sendCount}` } };
        }
        throw new Error(`Unhandled gmailRequest call: ${options.method} ${options.path}`);
      },
    );

    const service = new MailboxForwardingService({ db });
    await service.runNow(created.id);

    currentTime = Date.parse("2026-04-23T12:00:00.000Z");
    await service.runNow(created.id);

    expect(messageQueries).toHaveLength(2);
    expect(messageQueries[0]).toContain("after:2026/03/21");
    expect(messageQueries[1]).toContain("after:2026/04/20");
    expect(messageQueries[1]).not.toContain("after:2026/04/23");

    nowSpy.mockRestore();
  });

  it("recomputes nextRunAt after a manual run instead of reusing a stale past-due value", async () => {
    const { MailboxAutomationRegistry } = await import("../MailboxAutomationRegistry");
    const { MailboxForwardingService } = await import("../MailboxForwardingService");

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-04-23T12:00:00.000Z"));

    const created = MailboxAutomationRegistry.createForward({
      name: "Forward invoices",
      schedule: { kind: "every", everyMs: 15 * 60 * 1000 },
      targetEmail: "ops@example.com",
      allowedSenders: ["billing@vendor.com"],
      allowedDomains: [],
      attachmentExtensions: ["pdf"],
      dryRun: true,
    });
    MailboxAutomationRegistry.setForwardNextRun(created.id, Date.parse("2026-04-23T11:00:00.000Z"));

    gmailRequestMock.mockImplementation(
      async (_settings: unknown, options: { path: string; method: string; body?: Any }) => {
        if (options.path === "/users/me/labels" && options.method === "GET") {
          return { status: 200, data: { labels: [] } };
        }
        if (options.path === "/users/me/labels" && options.method === "POST") {
          return { status: 200, data: { id: `label-${Math.random()}` } };
        }
        if (options.path === "/users/me/messages" && options.method === "GET") {
          return { status: 200, data: { messages: [] } };
        }
        throw new Error(`Unhandled gmailRequest call: ${options.method} ${options.path}`);
      },
    );

    const service = new MailboxForwardingService({ db });
    await service.runNow(created.id);

    const refreshed = MailboxAutomationRegistry.listAutomations({ workspaceId: "ws-default" }).find(
      (item) => item.id === created.id,
    );
    expect(refreshed?.nextRunAt).toBe(Date.parse("2026-04-23T12:15:00.000Z"));

    nowSpy.mockRestore();
  });
});
