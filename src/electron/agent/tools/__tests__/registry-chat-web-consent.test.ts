import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({
  app: { getPath: () => "/tmp/cowork-fixture", isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
}));
import { ToolRegistry } from "../registry";

/** A bare registry exercising only the chat-scoped web consent. */
function registryWith(daemon: Record<string, unknown>) {
  const registry = Object.create(ToolRegistry.prototype) as Any;
  registry.taskId = "bot-chat";
  registry.daemon = daemon;
  registry.chatWebConsent = null;
  return registry as {
    requestChatWebConsent(tool: string, signal?: AbortSignal): Promise<boolean>;
  };
}

describe("chat-scoped read-only web consent", () => {
  it("asks once per chat and reuses consent while authority is unchanged", async () => {
    let authority: string | null = "authority-1";
    const requestApproval = vi.fn().mockResolvedValue(true);
    const getTaskConsentAuthority = vi.fn(async () => authority);
    const registry = registryWith({ requestApproval, getTaskConsentAuthority });

    expect(await registry.requestChatWebConsent("web_search")).toBe(true);
    expect(await registry.requestChatWebConsent("web_fetch")).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval).toHaveBeenCalledWith(
      "bot-chat",
      "network_access",
      expect.stringContaining("for this chat"),
      expect.objectContaining({ taskConsentLabel: "Allow for this chat" }),
      expect.objectContaining({ allowAutoApprove: false, requireExplicitApproval: true }),
    );
    expect(getTaskConsentAuthority).toHaveBeenCalledWith(
      "bot-chat",
      expect.anything(),
      "network_access",
    );

    // A policy or profile change invalidates the consent and asks again.
    authority = "authority-2";
    expect(await registry.requestChatWebConsent("web_fetch")).toBe(true);
    expect(requestApproval).toHaveBeenCalledTimes(2);

    // Without current authority (task ended, policy denies), nothing is asked or allowed.
    authority = null;
    expect(await registry.requestChatWebConsent("web_fetch")).toBe(false);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it("does not remember a denial or a consent whose authority changed while asking", async () => {
    const authorities = ["a", "b"];
    const getTaskConsentAuthority = vi.fn(async () => authorities.shift() ?? "b");
    const requestApproval = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const registry = registryWith({ requestApproval, getTaskConsentAuthority });

    expect(await registry.requestChatWebConsent("web_search")).toBe(false);
    // Authority moved from "a" to "b" during the second request: refuse and ask again later.
    authorities.push("a", "b");
    expect(await registry.requestChatWebConsent("web_search")).toBe(false);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it("refuses when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const requestApproval = vi.fn();
    const registry = registryWith({
      requestApproval,
      getTaskConsentAuthority: vi.fn(async () => "a"),
    });
    expect(await registry.requestChatWebConsent("web_search", controller.signal)).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
