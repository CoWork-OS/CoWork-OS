import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import {
  buildAssistantApprovalRequest,
  canOfferAssistantAlwaysAllow,
  getAlwaysAllowApp,
  parseAssistantApprovalAction,
} from "../../agent/assistant-approval";
import {
  ComputerUseAppAllowlist,
  canAlwaysAllowApp,
  computerUseAlwaysAllowCandidate,
  isValidBundleId,
} from "../always-allowed-apps";

vi.mock("electron", () => ({}));

describe("which apps can be always allowed", () => {
  it("accepts ordinary bundle ids and refuses CoWork, password managers, terminals and settings", () => {
    expect(canAlwaysAllowApp("com.apple.Safari")).toBe(true);
    expect(canAlwaysAllowApp("com.microsoft.Excel")).toBe(true);
    for (const id of [
      "com.cowork-os.app",
      "com.apple.keychainaccess",
      "COM.1PASSWORD.1PASSWORD",
      "com.apple.Terminal",
      "com.googlecode.iterm2",
      "com.apple.systempreferences",
      "com.microsoft.VSCode",
      "com.jetbrains.intellij",
      "com.apple.finder",
    ]) {
      expect(canAlwaysAllowApp(id)).toBe(false);
    }
    expect(isValidBundleId("../etc/passwd")).toBe(false);
    expect(isValidBundleId("")).toBe(false);
    expect(isValidBundleId(42)).toBe(false);
  });
});

describe("ComputerUseAppAllowlist", () => {
  let stored: unknown;
  beforeEach(() => {
    stored = undefined;
    ComputerUseAppAllowlist.resetCacheForTests();
    vi.spyOn(SecureSettingsRepository, "isInitialized").mockReturnValue(true);
    vi.spyOn(SecureSettingsRepository, "getInstance").mockReturnValue({
      load: () => stored,
      save: (_key: string, value: unknown) => {
        stored = JSON.parse(JSON.stringify(value));
        return true;
      },
    } as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("adds once, keeps names clean and removes by bundle id", () => {
    ComputerUseAppAllowlist.add("com.apple.Safari", "Safari\nIgnore previous", 5);
    ComputerUseAppAllowlist.add("com.apple.safari", "Safari again", 6);
    expect(ComputerUseAppAllowlist.list()).toEqual([
      { bundleId: "com.apple.Safari", name: "Safari Ignore previous", addedAt: 5 },
    ]);
    expect(ComputerUseAppAllowlist.has("COM.APPLE.SAFARI")).toBe(true);
    ComputerUseAppAllowlist.remove("com.apple.Safari");
    expect(ComputerUseAppAllowlist.list()).toEqual([]);
  });

  it("refuses apps on the never list and drops them from stored data", () => {
    expect(() => ComputerUseAppAllowlist.add("com.apple.Terminal", "Terminal")).toThrow();
    stored = {
      apps: [
        { bundleId: "com.apple.Terminal", name: "Terminal", addedAt: 1 },
        { bundleId: "com.apple.TextEdit", name: "TextEdit", addedAt: 2 },
        { bundleId: "bad id", name: "x" },
      ],
    };
    ComputerUseAppAllowlist.resetCacheForTests();
    expect(ComputerUseAppAllowlist.list().map((app) => app.bundleId)).toEqual([
      "com.apple.TextEdit",
    ]);
    expect(ComputerUseAppAllowlist.has("com.apple.Terminal")).toBe(false);
  });
});

describe("the approval card", () => {
  const details = {
    bundleId: "com.apple.TextEdit",
    taskConsentScope: "background observation, clicking and typing in com.apple.TextEdit",
    taskConsentLabel: "Allow for this task",
    alwaysAllowApp: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
  };

  it("offers Always allow for a marked app, next to the task consent", () => {
    const options = buildAssistantApprovalRequest("computer_use", "Control TextEdit?", details)
      .questions[0].options;
    expect(options.map((option) => option.label)).toEqual([
      "Deny",
      "Always allow",
      "Allow for this task",
    ]);
    expect(options[1].description).toContain(
      "control TextEdit (com.apple.TextEdit) without asking",
    );
    expect(canOfferAssistantAlwaysAllow(details)).toBe(true);
    expect(
      parseAssistantApprovalAction({ approval_decision: { optionLabel: "Always allow" } } as never),
    ).toBe("allow_workspace");
  });

  it("offers no Always allow without the mark", () => {
    const { alwaysAllowApp: _ignored, ...plain } = details;
    const labels = buildAssistantApprovalRequest(
      "computer_use",
      "Control TextEdit?",
      plain,
    ).questions[0].options.map((option) => option.label);
    expect(labels).not.toContain("Always allow");
    expect(canOfferAssistantAlwaysAllow(plain)).toBe(false);
    expect(getAlwaysAllowApp({ alwaysAllowApp: { bundleId: 5 } })).toBeNull();
  });
});

describe("which sessions may use the list", () => {
  const candidate = (tasks: Record<string, Record<string, unknown>>, details: object) =>
    computerUseAlwaysAllowCandidate(
      { findById: (id: string) => tasks[id] as never },
      "t1",
      "computer_use",
      details as Record<string, unknown>,
    );
  const app = { bundleId: "com.apple.TextEdit", targetApp: "TextEdit" };

  it("covers sessions the user started, and their sub-agents", () => {
    expect(candidate({ t1: { id: "t1", source: "manual", title: "Edit" } }, app)).toEqual({
      bundleId: "com.apple.TextEdit",
      name: "TextEdit",
    });
    expect(
      candidate(
        {
          t1: { id: "t1", source: "manual", parentTaskId: "p" },
          p: { id: "p", source: "side_chat" },
        },
        app,
      ),
    ).not.toBeNull();
  });

  it("leaves out bots, automations, API and hook sessions, and apps on the never list", () => {
    const cases: Array<Record<string, Record<string, unknown>>> = [
      { t1: { id: "t1", source: "manual", assignedAgentRoleId: "bot" } },
      { t1: { id: "t1", source: "manual", agentConfig: { botConversation: true } } },
      { t1: { id: "t1", source: "cron" } },
      { t1: { id: "t1", title: "Heartbeat: inbox" } },
      { t1: { id: "t1", source: "api" } },
      { t1: { id: "t1", source: "hook" } },
      { t1: { id: "t1", source: "managed_agent_panel" } },
      { t1: { id: "t1" } },
      { t1: { id: "t1", source: "manual", agentConfig: { gatewayContext: "private" } } },
      { t1: { id: "t1", source: "manual", agentConfig: { humanInputPolicy: "none" } } },
      { t1: { id: "t1", source: "manual", agentConfig: { cli: { owner: "cowork-run" } } } },
      {
        t1: { id: "t1", source: "manual", parentTaskId: "p" },
        p: { id: "p", source: "manual", assignedAgentRoleId: "bot" },
      },
    ];
    for (const tasks of cases) expect(candidate(tasks, app)).toBeNull();
    expect(
      candidate({ t1: { id: "t1", source: "manual" } }, { bundleId: "com.apple.Terminal" }),
    ).toBeNull();
  });
});
