import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../agent/approval-policy", async (original) => ({
  ...(await original<typeof import("../../agent/approval-policy")>()),
  approvalPromptsDisabled: () => true,
}));
import { AgentDaemon } from "../../agent/daemon";
import { ApprovalStore } from "../../database/repositories";
import { SecureSettingsRepository } from "../../database/SecureSettingsRepository";
import { nativeSqliteAvailable } from "../../memory/__tests__/memory-items-test-db";
import { ComputerUseAppAllowlist } from "../always-allowed-apps";

const suite = nativeSqliteAvailable ? describe : describe.skip;

/** "Always allow" on a computer use card adds the app only when answered in the desktop app. */
suite("Always allow answers on a computer use card", () => {
  let db: Database.Database;
  let stored: unknown;
  beforeEach(async () => {
    const { default: Sqlite } = await import("better-sqlite3");
    db = new Sqlite(":memory:");
    db.exec(
      "CREATE TABLE approvals(id TEXT PRIMARY KEY,task_id TEXT,type TEXT,description TEXT,details TEXT,status TEXT,requested_at INTEGER,resolved_at INTEGER,resolved_by_principal_id TEXT,resolved_by_role TEXT);",
    );
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
  afterEach(() => {
    vi.restoreAllMocks();
    ComputerUseAppAllowlist.resetCacheForTests();
    db.close();
  });

  const run = async (origin: "desktop" | undefined) => {
    const task = {
      id: "task",
      status: "executing",
      source: "manual",
      agentConfig: { accessProfileId: "ask_for_approval" },
    };
    let answer!: (value: Any) => void;
    const response = new Promise<Any>((resolve) => (answer = resolve));
    const runtime = { recordPermissionSuccess: vi.fn(), recordPermissionDenial: vi.fn() };
    const daemon = {
      approvalRepo: new ApprovalStore(db),
      taskRepo: { findById: () => task },
      pendingApprovals: new Map(),
      requestUserInput: vi.fn(() => response),
      dismissPendingAssistantApproval: vi.fn().mockResolvedValue(undefined),
      requestAssistantApproval: AgentDaemon.prototype["requestAssistantApproval"],
      isApprovalAuthorityCurrent: vi.fn().mockResolvedValue(true),
      evaluatePermissionRequest: vi.fn().mockResolvedValue({
        evaluation: { decision: "ask", reason: { type: "mode", mode: "default", summary: "Ask" } },
        promptDetails: { scope: { kind: "tool", toolName: "native_app" } },
        trackingKey: "exact",
        authorizationKey: "exact",
        workspace: { id: "ws", path: "/tmp/ws", permissions: { read: true } },
        runtime,
      }),
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      grantExternalFileApprovalsFromDetails: vi.fn(),
    } as Any;
    const result = AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task",
      "computer_use",
      "Control com.apple.TextEdit in the background for this task",
      {
        tool: "native_app",
        bundleId: "com.apple.TextEdit",
        targetApp: "TextEdit",
        taskConsentScope: "background observation, clicking and typing in com.apple.TextEdit",
        taskConsentLabel: "Allow for this task",
      },
    );
    await vi.waitFor(() => expect(daemon.requestUserInput).toHaveBeenCalledOnce());
    const offered = (daemon.requestUserInput.mock.calls[0] as Any[])[1].questions[0].options.map(
      (option: { label: string }) => option.label,
    );
    expect(offered).toContain("Always allow");
    answer({
      requestId: "input-fixture",
      status: "submitted",
      answers: { approval_decision: { optionLabel: "Always allow" } },
      ...(origin ? { origin } : {}),
    });
    return result;
  };

  it("adds the app when answered in the desktop app", async () => {
    expect(await run("desktop")).toBe(true);
    expect(ComputerUseAppAllowlist.list().map((app) => [app.bundleId, app.name])).toEqual([
      ["com.apple.TextEdit", "TextEdit"],
    ]);
  });

  it("allows once, and adds nothing, when answered elsewhere", async () => {
    expect(await run(undefined)).toBe(true);
    expect(ComputerUseAppAllowlist.list()).toEqual([]);
  });
});
