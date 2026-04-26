import { describe, expect, it } from "vitest";
import {
  getMailboxProviderCapabilities,
  mergeMailboxCapabilities,
  resolveMailboxProviderBackend,
} from "../MailboxProviderClient";

describe("MailboxProviderClient capability mapping", () => {
  it("maps Gmail to the Gmail API backend with replacement-client capabilities", () => {
    const backend = resolveMailboxProviderBackend({ provider: "gmail" });

    expect(backend).toBe("gmail_api");
    expect(getMailboxProviderCapabilities(backend)).toEqual(
      expect.arrayContaining(["sync", "provider_search", "send", "provider_drafts", "labels", "undo_send"]),
    );
  });

  it("maps Outlook Graph accounts to Microsoft Graph", () => {
    const backend = resolveMailboxProviderBackend({
      provider: "outlook_graph",
    });

    expect(backend).toBe("microsoft_graph");
    expect(getMailboxProviderCapabilities(backend)).toEqual(
      expect.arrayContaining(["sync", "provider_search", "send", "provider_drafts", "folders", "move"]),
    );
  });

  it("keeps existing IMAP accounts on the IMAP/SMTP fallback unless Graph is present", () => {
    expect(resolveMailboxProviderBackend({ provider: "imap" })).toBe("imap_smtp");
    expect(resolveMailboxProviderBackend({ provider: "imap", capabilities: ["microsoft_graph"] })).toBe("microsoft_graph");
  });

  it("merges stored capabilities while dropping legacy unknown values", () => {
    expect(mergeMailboxCapabilities(["threads", "labels", "send"], "gmail_api")).toEqual(
      expect.arrayContaining(["labels", "send", "provider_drafts"]),
    );
    expect(mergeMailboxCapabilities(["threads"], "gmail_api")).not.toContain("threads");
  });
});
