import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DatabaseManager } from "../../electron/database/schema";
import {
  ApprovalStore,
  InputRequestStore,
  TaskStore,
  WorkspaceStore,
} from "../../electron/database/repositories";
import { approvalRequestRevisionHash } from "../../electron/agent/approval-revision";
import { ErrorCodes, Events, Methods } from "../../electron/control-plane/protocol";
import type { ControlPlaneServer } from "../../electron/control-plane/server";
import { TASK_EVENT_BRIDGE_ALLOWLIST } from "../../electron/control-plane/task-event-bridge-contract";
import type { AgentDaemon } from "../../electron/agent/daemon";
import {
  attachAgentDaemonTaskBridge,
  registerControlPlaneMethods,
  sanitizeInputRequestRespondParams,
} from "../control-plane-methods";

const nativeSqliteAvailable = (() => {
  try {
    const probe = new Database(":memory:");
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

type RegisteredMethod = (
  client: { hasScope(scope: string): boolean },
  params?: unknown,
) => Promise<unknown>;

function createMethodRegistry() {
  const methods = new Map<string, RegisteredMethod>();
  const server = {
    registerMethod: (method: string, handler: RegisteredMethod) => methods.set(method, handler),
  } as unknown as ControlPlaneServer;
  return { methods, server };
}

function scopedClient(scopes: string[]) {
  return { hasScope: (scope: string) => scopes.includes(scope) };
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error ?? "");
}

describe("control-plane input request response sanitization", () => {
  it("accepts valid payload and trims answer strings", () => {
    const sanitized = sanitizeInputRequestRespondParams({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      status: "submitted",
      answers: {
        delivery_mode: {
          optionLabel: " Desktop + API (Recommended) ",
          otherText: " Ship both surfaces ",
        },
      },
    });

    expect(sanitized).toEqual({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      status: "submitted",
      answers: {
        delivery_mode: {
          optionLabel: "Desktop + API (Recommended)",
          otherText: "Ship both surfaces",
        },
      },
    });
  });

  it("rejects non-UUID request ids", () => {
    try {
      sanitizeInputRequestRespondParams({
        requestId: "not-a-uuid",
        status: "submitted",
      });
      throw new Error("Expected sanitizeInputRequestRespondParams to throw");
    } catch (error: unknown) {
      expect(getErrorMessage(error)).toMatch(/requestId must be a UUID/i);
    }
  });

  it("rejects non-snake-case answer keys", () => {
    try {
      sanitizeInputRequestRespondParams({
        requestId: "550e8400-e29b-41d4-a716-446655440000",
        status: "submitted",
        answers: {
          NotSnakeCase: { optionLabel: "A" },
        },
      });
      throw new Error("Expected sanitizeInputRequestRespondParams to throw");
    } catch (error: unknown) {
      expect(getErrorMessage(error)).toMatch(/must match/i);
    }
  });

  it("rejects invalid answer value shapes", () => {
    try {
      sanitizeInputRequestRespondParams({
        requestId: "550e8400-e29b-41d4-a716-446655440000",
        status: "submitted",
        answers: {
          delivery_mode: "desktop",
        },
      });
      throw new Error("Expected sanitizeInputRequestRespondParams to throw");
    } catch (error: unknown) {
      expect(getErrorMessage(error)).toMatch(/must be an object/i);
    }
  });
});

describeWithSqlite("Node Control Plane browser parity", () => {
  let tempDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-node-control-plane-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tempDir;
    manager = new DatabaseManager({ dbPath: path.join(tempDir, "test.db") });
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function registerMethods(agentDaemon: Record<string, unknown>) {
    const { methods, server } = createMethodRegistry();
    registerControlPlaneMethods(server, {
      agentDaemon: {
        ...agentDaemon,
        getWorkSessionReliabilityService: () => ({}),
      } as unknown as AgentDaemon,
      dbManager: { getDatabase: () => manager.getDatabase() } as never,
    });
    return methods;
  }

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

  it("creates workspaces with delete on and shell off", async () => {
    const methods = registerMethods({});
    const handler = methods.get(Methods.WORKSPACE_CREATE);
    expect(handler).toBeDefined();
    const result = (await handler!(scopedClient(["admin"]), {
      name: "Created",
      path: path.join(tempDir, "created-workspace"),
    })) as { workspace: { id: string; permissions: Record<string, unknown> } };
    expect(result.workspace.permissions).toMatchObject({
      read: true,
      write: true,
      delete: true,
      shell: false,
    });
    const stored = new WorkspaceStore(manager.getDatabase()).findById(result.workspace.id);
    expect(stored?.permissions.delete).toBe(true);
  });

  it("presents and resolves only the listed approval revision on Node Control Plane", async () => {
    const workspace = createWorkspace();
    const task = new TaskStore(manager.getDatabase()).create({
      title: "Approval review",
      prompt: "Review a concrete draft",
      status: "blocked",
      workspaceId: workspace.id,
    });
    const approval = new ApprovalStore(manager.getDatabase()).create({
      taskId: task.id,
      type: "data_export",
      description: "Review the export draft",
      details: { reviewFiles: ["draft.md"] },
      status: "pending",
      requestedAt: Date.now(),
    });
    const respondToApproval = vi.fn().mockResolvedValue("handled");
    const methods = registerMethods({ respondToApproval });
    const admin = scopedClient(["admin"]);
    const expectedRevisionHash = approvalRequestRevisionHash(approval);

    const taskScoped = (await methods.get(Methods.APPROVAL_LIST)!(admin, {
      taskId: task.id,
    })) as { approvals: Array<{ id: string; revisionHash?: string }> };
    const global = (await methods.get(Methods.APPROVAL_LIST)!(admin, {})) as {
      approvals: Array<{ id: string; revisionHash?: string }>;
    };
    expect(taskScoped.approvals).toContainEqual(
      expect.objectContaining({ id: approval.id, revisionHash: expectedRevisionHash }),
    );
    expect(global.approvals).toContainEqual(
      expect.objectContaining({ id: approval.id, revisionHash: expectedRevisionHash }),
    );

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
        expectedRevisionHash: "invalid",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(respondToApproval).toHaveBeenCalledOnce();
  });

  it("uses durable daemon admission only for explicit operation keys", async () => {
    const workspace = createWorkspace();
    const task = new TaskStore(manager.getDatabase()).create({
      title: "Browser task",
      prompt: "Review the workspace",
      status: "queued",
      workspaceId: workspace.id,
      source: "api",
      sessionId: "browser-session-1",
      resumeStrategy: "snapshot",
    });
    const createTaskIdempotent = vi.fn().mockResolvedValue({ task, replayed: true });
    const startAdmittedTask = vi.fn().mockResolvedValue(undefined);
    const methods = registerMethods({ createTaskIdempotent, startAdmittedTask });
    const handler = methods.get(Methods.TASK_CREATE);
    expect(handler).toBeDefined();

    await expect(
      handler!(scopedClient(["admin"]), {
        title: " Browser task ",
        prompt: " Review the workspace ",
        workspaceId: workspace.id,
        operationKey: " browser-op-1 ",
        assignedAgentRoleId: " role-1 ",
      }),
    ).resolves.toMatchObject({ taskId: task.id, task, replayed: true });

    expect(createTaskIdempotent).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: "browser-op-1",
        title: "Browser task",
        prompt: "Review the workspace",
        workspaceId: workspace.id,
        source: "api",
        taskOverrides: { assignedAgentRoleId: "role-1" },
        boardColumn: "todo",
        autoStart: false,
        requestIdentity: expect.objectContaining({
          title: "Browser task",
          prompt: "Review the workspace",
          assignedAgentRoleId: "role-1",
        }),
      }),
    );
    expect(startAdmittedTask).toHaveBeenCalledWith("browser-op-1", task.id);
  });

  it("rejects an explicitly supplied invalid operation key before creating a task", async () => {
    const workspace = createWorkspace();
    const createTaskIdempotent = vi.fn();
    const methods = registerMethods({ createTaskIdempotent });

    await expect(
      methods.get(Methods.TASK_CREATE)!(scopedClient(["admin"]), {
        title: "Browser task",
        prompt: "Review the workspace",
        workspaceId: workspace.id,
        operationKey: "   ",
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(createTaskIdempotent).not.toHaveBeenCalled();
    expect(manager.getDatabase().prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 0,
    });
  });

  it("keeps legacy task.create on its existing creation and start path without a key", async () => {
    const workspace = createWorkspace();
    const startTask = vi.fn().mockResolvedValue(undefined);
    const createTaskIdempotent = vi.fn();
    const methods = registerMethods({ startTask, createTaskIdempotent });
    const result = (await methods.get(Methods.TASK_CREATE)!(scopedClient(["admin"]), {
      title: "Legacy task",
      prompt: "Review the workspace",
      workspaceId: workspace.id,
    })) as { taskId: string; task: { status: string }; replayed?: boolean };

    expect(result.taskId).toBeTruthy();
    expect(result.task.status).toBe("pending");
    expect(result).not.toHaveProperty("replayed");
    expect(startTask).toHaveBeenCalledWith(expect.objectContaining({ id: result.taskId }));
    expect(createTaskIdempotent).not.toHaveBeenCalled();
  });

  it("forwards every supported follow-up field and preserves the daemon acceptance result", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      messageId: "message-accepted-1",
      deliveryMode: "follow_up",
      accepted: true,
    });
    const methods = registerMethods({ sendMessage });
    const handler = methods.get(Methods.TASK_SEND_MESSAGE);
    expect(handler).toBeDefined();

    const taskId = "550e8400-e29b-41d4-a716-446655440000";
    const quote = {
      eventId: "event-quoted-1",
      taskId,
      message: "The prior assistant answer",
      truncated: true,
    };
    const image = { data: "aGVsbG8=", mimeType: "image/png", sizeBytes: 5 };
    const integrationMention = {
      id: "builtin:filesystem",
      label: "Workspace files",
      source: "builtin",
      providerKey: "builtin",
      iconKey: "folder",
      tools: ["file_search"],
      promptHint: "Search workspace files",
    };

    await expect(
      handler!(scopedClient(["admin"]), {
        taskId: ` ${taskId} `,
        message: " Continue from the quote ",
        images: [image],
        quotedAssistantMessage: quote,
        expectedTurnId: " turn-7 ",
        interactionMode: { mode: "chat" },
        deliveryMode: "follow_up",
        returnOnAccepted: true,
        messageId: " message-client-9 ",
        permissionMode: "plan",
        accessProfileId: " full_access ",
        shellAccess: false,
        integrationMentions: [integrationMention],
      }),
    ).resolves.toEqual({
      ok: true,
      messageId: "message-accepted-1",
      deliveryMode: "follow_up",
      accepted: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(taskId, "Continue from the quote", [image], quote, {
      expectedTurnId: "turn-7",
      interactionMode: { mode: "chat" },
      deliveryMode: "follow_up",
      returnOnAccepted: true,
      messageId: "message-client-9",
      permissionMode: "plan",
      accessProfileId: "full_access",
      shellAccess: false,
      integrationMentions: [integrationMention],
    });
  });

  it("bridges the shared task-event allowlist, including approval and input changes", () => {
    const listeners = new Map<string, (event: unknown) => void>();
    const daemon = {
      on: vi.fn((event: string, listener: (value: unknown) => void) =>
        listeners.set(event, listener),
      ),
      off: vi.fn((event: string) => listeners.delete(event)),
    } as unknown as AgentDaemon;
    const broadcastToOperators = vi.fn();
    const server = { broadcastToOperators } as unknown as ControlPlaneServer;

    const detach = attachAgentDaemonTaskBridge(server, daemon);
    expect([...listeners.keys()]).toEqual(TASK_EVENT_BRIDGE_ALLOWLIST);

    for (const [index, type] of TASK_EVENT_BRIDGE_ALLOWLIST.entries()) {
      listeners.get(type)?.({
        taskId: "task-1",
        payload: { requestId: `request-${index}` },
        timestamp: 1234,
        eventId: `event-${index}`,
        seq: index + 1,
      });
    }

    expect(broadcastToOperators).toHaveBeenCalledTimes(TASK_EVENT_BRIDGE_ALLOWLIST.length);
    expect(
      broadcastToOperators.mock.calls.map(([eventName, payload]) => [eventName, payload.type]),
    ).toEqual(TASK_EVENT_BRIDGE_ALLOWLIST.map((type) => [Events.TASK_EVENT, type]));
    expect(broadcastToOperators).toHaveBeenCalledWith(
      Events.TASK_EVENT,
      expect.objectContaining({
        taskId: "task-1",
        type: "input_request_created",
        timestamp: 1234,
        eventId: "event-3",
        seq: 4,
      }),
    );

    detach();
    expect(listeners.size).toBe(0);
    expect(daemon.off).toHaveBeenCalledTimes(TASK_EVENT_BRIDGE_ALLOWLIST.length);
  });

  it("lists pending input for admins and validates/responds to input with admin scope", async () => {
    const db = manager.getDatabase();
    const workspaceId = "550e8400-e29b-41d4-a716-446655440000";
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(workspaceId, "Workspace", path.join(tempDir, "workspace"), Date.now(), "{}");
    const task = new TaskStore(db).create({
      title: "Input request task",
      prompt: "Wait for an answer",
      status: "paused",
      workspaceId,
    });
    const inputStore = new InputRequestStore(db);
    const pending = inputStore.create({
      taskId: task.id,
      questions: [
        {
          header: "Delivery",
          id: "delivery_mode",
          question: "Which delivery should we use?",
          options: [{ label: "Browser", description: "Continue in the browser" }],
        },
      ],
      requestedAt: 1,
    });
    inputStore.create({
      taskId: task.id,
      questions: [],
      requestedAt: 2,
      status: "submitted",
    });

    const respondToInputRequest = vi.fn().mockResolvedValue({
      status: "handled",
      requestId: pending.id,
    });
    const methods = registerMethods({ respondToInputRequest });
    const list = methods.get(Methods.INPUT_REQUEST_LIST);
    const respond = methods.get(Methods.INPUT_REQUEST_RESPOND);
    expect(list).toBeDefined();
    expect(respond).toBeDefined();

    await expect(
      list!(scopedClient(["admin"]), {
        taskId: ` ${task.id} `,
        status: "pending",
        limit: 25,
        offset: 0,
      }),
    ).resolves.toMatchObject({
      inputRequests: [
        {
          id: pending.id,
          taskId: task.id,
          status: "pending",
          taskTitle: "Input request task",
          questions: [{ id: "delivery_mode" }],
        },
      ],
    });

    await expect(list!(scopedClient(["read"]), { status: "pending" })).rejects.toMatchObject({
      code: ErrorCodes.UNAUTHORIZED,
    });
    await expect(
      respond!(scopedClient(["read"]), {
        requestId: pending.id,
        status: "submitted",
        answers: { delivery_mode: { optionLabel: "Browser" } },
      }),
    ).rejects.toMatchObject({ code: ErrorCodes.UNAUTHORIZED });
    await expect(
      respond!(scopedClient(["admin"]), { requestId: "not-a-uuid", status: "submitted" }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    expect(respondToInputRequest).not.toHaveBeenCalled();

    await expect(
      respond!(scopedClient(["admin"]), {
        requestId: pending.id,
        status: "submitted",
        answers: { delivery_mode: { optionLabel: " Browser " } },
      }),
    ).resolves.toEqual({ status: "handled", requestId: pending.id });
    expect(respondToInputRequest).toHaveBeenCalledWith({
      requestId: pending.id,
      status: "submitted",
      answers: { delivery_mode: { optionLabel: "Browser" } },
    });
  });
});
