import fs from "node:fs";
import { Script, runInNewContext } from "node:vm";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDaemon } from "../../agent/daemon";
import { approvalRequestRevisionHash } from "../../agent/approval-revision";
import { DatabaseManager } from "../../database/schema";
import { ApprovalStore, TaskStore, WorkspaceStore } from "../../database/repositories";
import type { ControlPlaneServer } from "../server";
import { ErrorCodes, Methods } from "../protocol";
import { getControlPlaneWebUIHtml } from "../web-ui";
import { registerTaskAndWorkspaceMethods } from "../handlers";

type RegisteredMethod = (
  client: { hasScope(scope: string): boolean },
  params?: unknown,
) => Promise<unknown>;

describe("Electron Control Plane approval revision contract", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let methods: Map<string, RegisteredMethod>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-electron-approval-revision-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager({ dbPath: path.join(tempDir, "test.db") });
    methods = new Map();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createWorkspace() {
    const workspacePath = path.join(tempDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    return new WorkspaceStore(manager.getDatabase()).create("Workspace", workspacePath, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
  }

  function register(agentDaemon: Record<string, unknown>) {
    const server = {
      registerMethod: (method: string, handler: RegisteredMethod) => methods.set(method, handler),
    } as unknown as ControlPlaneServer;
    registerTaskAndWorkspaceMethods(server, {
      agentDaemon: {
        ...agentDaemon,
        getWorkSessionReliabilityService: () => ({}),
      } as unknown as AgentDaemon,
      dbManager: { getDatabase: () => manager.getDatabase() } as never,
    });
  }

  it("returns the displayed hash from both list branches and binds responses to it", async () => {
    const workspace = createWorkspace();
    const task = new TaskStore(manager.getDatabase()).create({
      title: "Approval review",
      prompt: "Review a command approval",
      status: "blocked",
      workspaceId: workspace.id,
    });
    const approval = new ApprovalStore(manager.getDatabase()).create({
      taskId: task.id,
      type: "run_command",
      description: "Review command arguments",
      details: { command: "tool --target draft.md", arguments: ["--safe"] },
      status: "pending",
      requestedAt: Date.now(),
    });
    const respondToApproval = vi.fn().mockResolvedValue("handled");
    register({ respondToApproval });
    const admin = { hasScope: (scope: string) => scope === "admin" };
    const expectedRevisionHash = approvalRequestRevisionHash(approval);

    const taskScoped = (await methods.get(Methods.APPROVAL_LIST)!(admin, {
      taskId: task.id,
    })) as { approvals: Array<{ id: string; revisionHash?: string }> };
    const global = (await methods.get(Methods.APPROVAL_LIST)!(admin, {})) as {
      approvals: Array<{ id: string; revisionHash?: string }>;
    };
    for (const response of [taskScoped, global]) {
      expect(response.approvals).toContainEqual(
        expect.objectContaining({ id: approval.id, revisionHash: expectedRevisionHash }),
      );
    }

    await expect(
      methods.get(Methods.APPROVAL_RESPOND)!(admin, {
        approvalId: approval.id,
        approved: true,
        expectedRevisionHash,
      }),
    ).resolves.toEqual({ status: "handled" });
    expect(respondToApproval).toHaveBeenCalledWith(
      approval.id,
      true,
      undefined,
      undefined,
      expectedRevisionHash,
    );

    await expect(
      methods.get(Methods.APPROVAL_RESPOND)!(admin, {
        approvalId: approval.id,
        approved: true,
        expectedRevisionHash: "not-a-hash",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(respondToApproval).toHaveBeenCalledOnce();
  });
});

describe("generated Control Plane approval decisions", () => {
  const embeddedScript = () => {
    const match = getControlPlaneWebUIHtml().match(/<script>([\s\S]*?)<\/script>/);
    if (!match) throw new Error("Missing Control Plane script");
    return match[1];
  };

  it("produces syntactically valid browser JavaScript", () => {
    expect(() => new Script(embeddedScript())).not.toThrow();
  });

  it.each(["handled", "duplicate", "not_found", "in_progress", "unknown"])(
    "sends the displayed hash and reports %s truthfully",
    async (status) => {
      const script = embeddedScript();
      const start = script.indexOf("async function submitApprovalDecision(");
      const end = script.indexOf("function renderApprovals()", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const request = vi.fn().mockResolvedValue({ status });
      const refreshApprovals = vi.fn().mockResolvedValue(undefined);
      const alert = vi.fn();
      const context: Record<string, unknown> = { request, refreshApprovals, alert };
      runInNewContext(script.slice(start, end), context);
      const submit = context.submitApprovalDecision as (
        approval: { id: string; revisionHash: string },
        approved: boolean,
        approveButton: { disabled: boolean },
        denyButton: { disabled: boolean },
      ) => Promise<void>;
      const approval = { id: "displayed-approval", revisionHash: "a".repeat(64) };
      const approveButton = { disabled: false };
      const denyButton = { disabled: false };
      await submit(approval, true, approveButton, denyButton);
      expect(request).toHaveBeenCalledWith("approval.respond", {
        approvalId: approval.id,
        approved: true,
        expectedRevisionHash: approval.revisionHash,
      });
      expect(refreshApprovals).toHaveBeenCalledOnce();
      expect(alert).toHaveBeenCalledTimes(status === "handled" || status === "duplicate" ? 0 : 1);
      expect(approveButton.disabled).toBe(false);
      expect(denyButton.disabled).toBe(false);
    },
  );
});
