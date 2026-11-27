import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../agent/approval-policy", async (original) => ({
  ...(await original<typeof import("../../agent/approval-policy")>()),
  approvalPromptsDisabled: () => true,
}));
import { AgentDaemon } from "../../agent/daemon";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { ComputerUseAppAllowlist } from "../always-allowed-apps";

/** requestApproval answers a computer use request for an always-allowed app without asking. */
describe("always-allowed apps in requestApproval", () => {
  let stored: unknown;
  beforeEach(() => {
    stored = { apps: [{ bundleId: "com.apple.TextEdit", name: "TextEdit", addedAt: 1 }] };
    ComputerUseAppAllowlist.resetCacheForTests();
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue({
      load: () => stored,
      save: () => true,
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ComputerUseAppAllowlist.resetCacheForTests();
  });

  const makeDaemon = (task: Record<string, unknown>, decision: "ask" | "deny" = "ask") => {
    const runtime = { recordPermissionSuccess: vi.fn(), recordPermissionDenial: vi.fn() };
    return {
      runtime,
      daemon: {
        taskRepo: { findById: () => task },
        pendingApprovals: new Map(),
        requestUserInput: vi.fn(() => new Promise(() => {})),
        evaluatePermissionRequest: vi.fn().mockResolvedValue({
          evaluation: {
            decision,
            reason: { type: "mode", mode: "default", summary: "Review" },
          },
          promptDetails: undefined,
          trackingKey: "exact",
          workspace: { id: "ws", path: "/tmp/ws", permissions: { read: true } },
          runtime,
        }),
        logEvent: vi.fn(),
        updateTask: vi.fn(),
      } as Any,
    };
  };

  it("allows a listed app in a session the user started, without a card", async () => {
    const { daemon, runtime } = makeDaemon({
      id: "task",
      status: "executing",
      source: "manual",
      agentConfig: { accessProfileId: "ask_for_approval" },
    });
    const approved = await AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task",
      "computer_use",
      "Allow visible Computer Use to control TextEdit?",
      {
        kind: "computer_use_foreground_control",
        bundleId: "com.apple.TextEdit",
        targetApp: "TextEdit",
      },
      { allowAutoApprove: false },
    );
    expect(approved).toBe(true);
    expect(daemon.requestUserInput).not.toHaveBeenCalled();
    expect(runtime.recordPermissionSuccess).toHaveBeenCalledWith("exact");
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task",
      "log",
      expect.objectContaining({ reason: "always_allowed_app", bundleId: "com.apple.TextEdit" }),
    );
  });

  it("does not allow an app that is not listed, nor a listed app in a bot's session", async () => {
    for (const [task, bundleId] of [
      [{ id: "task", status: "executing", source: "manual" }, "com.apple.Notes"],
      [
        { id: "task", status: "executing", source: "manual", assignedAgentRoleId: "bot" },
        "com.apple.TextEdit",
      ],
    ] as const) {
      const { daemon } = makeDaemon({
        ...task,
        agentConfig: { accessProfileId: "ask_for_approval" },
      });
      const controller = new AbortController();
      const pending = AgentDaemon.prototype.requestApproval
        .call(
          daemon,
          "task",
          "computer_use",
          "Control it?",
          { bundleId, targetApp: "App", alwaysAllowApp: { bundleId, name: "Forged" } },
          { signal: controller.signal },
        )
        .catch(() => false);
      await new Promise((resolve) => setTimeout(resolve, 20));
      controller.abort();
      expect(await pending).not.toBe(true);
      expect(daemon.logEvent).not.toHaveBeenCalledWith(
        "task",
        "log",
        expect.objectContaining({ reason: "always_allowed_app" }),
      );
    }
  });

  it("never overrides a deny", async () => {
    const { daemon } = makeDaemon(
      {
        id: "task",
        status: "executing",
        source: "manual",
        agentConfig: { accessProfileId: "ask_for_approval" },
      },
      "deny",
    );
    const approved = await AgentDaemon.prototype.requestApproval
      .call(daemon, "task", "computer_use", "Control TextEdit?", {
        bundleId: "com.apple.TextEdit",
        targetApp: "TextEdit",
      })
      .catch(() => false);
    expect(approved).toBe(false);
  });
});
