import { beforeEach, describe, expect, it, vi } from "vitest";

const createMailboxDraft = vi.fn();
const getMailboxClientState = vi.fn();
const isAvailable = vi.fn();

vi.mock("../../../mailbox/MailboxService", () => ({
  MailboxService: class {
    createMailboxDraft = createMailboxDraft;
    getMailboxClientState = getMailboxClientState;
    isAvailable = isAvailable;
  },
}));

import { MailboxTools } from "../mailbox-tools";

describe("MailboxTools", () => {
  beforeEach(() => {
    createMailboxDraft.mockReset();
    getMailboxClientState.mockReset();
    isAvailable.mockReset();
  });

  it("creates a product mailbox compose frame for assistant-generated drafts", async () => {
    createMailboxDraft.mockResolvedValue({
      id: "draft-1",
      accountId: "account-1",
      mode: "new",
      status: "local",
    });
    getMailboxClientState.mockResolvedValue({
      accounts: [{ id: "account-1", provider: "gmail" }],
    });
    const daemon = { logEvent: vi.fn() };
    const tools = new MailboxTools(
      { id: "workspace-1" } as Any,
      daemon as Any,
      "task-1",
      {} as Any,
    );

    const result = await tools.executeAction({
      action: "create_compose_frame",
      to: [{ email: "person@example.com" }],
      subject: "Hello",
      body_text: "Draft body",
    });

    expect(createMailboxDraft).toHaveBeenCalledWith({
      accountId: undefined,
      threadId: undefined,
      mode: "new",
      subject: "Hello",
      bodyText: "Draft body",
      bodyHtml: undefined,
      to: [{ email: "person@example.com" }],
      cc: undefined,
      bcc: undefined,
    });
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "assistant_message",
      expect.objectContaining({
        inlineFrames: [
          {
            kind: "mail_compose",
            draftId: "draft-1",
            accountId: "account-1",
            provider: "gmail",
            mode: "new",
            origin: "assistant_generated",
            status: "local",
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      success: true,
      action: "create_compose_frame",
      data: { draft: { id: "draft-1" } },
    });
  });
});
