import { describe, expect, it, vi } from "vitest";
import type { Task, TaskEvent, Workspace } from "../../shared/types";
import {
  createBrowserDecisionBridge,
  type BrowserDecisionBridgeOptions,
} from "./browser-decision-bridge";

const workspaceOne = { id: "workspace-one", name: "One", isTemp: false } as Workspace;
const workspaceTwo = { id: "workspace-two", name: "Two", isTemp: false } as Workspace;
const taskOne = {
  id: "task-one",
  workspaceId: workspaceOne.id,
  title: "First task",
  status: "blocked",
} as Task;
const taskTwo = {
  id: "task-two",
  workspaceId: workspaceTwo.id,
  title: "Second task",
  status: "paused",
} as Task;
const inputId = "123e4567-e89b-42d3-a456-426614174000";

function approval(overrides: Record<string, unknown> = {}) {
  return {
    id: "approval-one",
    taskId: taskOne.id,
    workspaceId: workspaceOne.id,
    taskTitle: taskOne.title,
    taskStatus: taskOne.status,
    type: "run_command",
    description: "Run the reviewed command",
    details: { command: "npm run build" },
    status: "pending",
    requestedAt: 100,
    expectedVersion: 100,
    ...overrides,
  };
}

function inputRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: inputId,
    taskId: taskOne.id,
    workspaceId: workspaceOne.id,
    taskTitle: taskOne.title,
    taskStatus: taskOne.status,
    questions: [
      {
        header: "Format",
        id: "output_format",
        question: "Which format should I use?",
        options: [
          { label: "PDF", description: "Portable" },
          { label: "DOCX", description: "Editable" },
        ],
      },
    ],
    status: "pending",
    requestedAt: 200,
    expectedVersion: 200,
    ...overrides,
  };
}

function event(type: TaskEvent["type"], payload: Record<string, unknown>, taskId = taskOne.id) {
  return {
    id: `event-${type}`,
    taskId,
    timestamp: 300,
    type,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

function createBridge(data?: {
  approvals?: Array<Record<string, unknown>>;
  inputs?: Array<Record<string, unknown>>;
  mutate?: (method: string, params: unknown) => Promise<unknown>;
}) {
  const approvals = data?.approvals ?? [];
  const inputs = data?.inputs ?? [];
  const rpc = vi.fn(async (method: string, params: unknown) => {
    const scope = params as { workspaceId: string; taskId?: string; offset: number; limit: number };
    const matching = (method === "approval.list" ? approvals : inputs).filter(
      (row) =>
        row.workspaceId === scope.workspaceId && (!scope.taskId || row.taskId === scope.taskId),
    );
    const offset = scope.offset ?? 0;
    const limit = scope.limit ?? 100;
    const rows = matching.slice(offset, offset + limit);
    return {
      [method === "approval.list" ? "approvals" : "inputRequests"]: rows,
      hasMore: matching.length > offset + limit,
    };
  });
  const mutate = vi.fn(data?.mutate ?? (async () => ({ status: "handled" })));
  const options: BrowserDecisionBridgeOptions = {
    rpc: rpc as unknown as BrowserDecisionBridgeOptions["rpc"],
    listWorkspaces: vi.fn(async () => [workspaceOne, workspaceTwo]),
    getTask: vi.fn(async (id) =>
      id === taskOne.id ? taskOne : id === taskTwo.id ? taskTwo : null,
    ),
    mutate: mutate as unknown as BrowserDecisionBridgeOptions["mutate"],
  };
  return { bridge: createBrowserDecisionBridge(options), rpc, mutate, options };
}

describe("browser decision bridge", () => {
  it("lists pending input requests across readable workspaces and scopes task queries to the real task", async () => {
    const { bridge, rpc } = createBridge({
      inputs: [
        inputRequest({ answers: { output_format: { optionLabel: "secret answer" } } }),
        inputRequest({
          id: "223e4567-e89b-42d3-a456-426614174000",
          taskId: taskTwo.id,
          workspaceId: workspaceTwo.id,
          expectedVersion: 201,
          requestedAt: 201,
        }),
      ],
    });

    const all = await bridge.methods.listInputRequests({ limit: 20, offset: 0, status: "pending" });
    expect(all.map((request) => request.id)).toEqual([
      inputId,
      "223e4567-e89b-42d3-a456-426614174000",
    ]);
    expect(JSON.stringify(all)).not.toContain("secret answer");
    expect(rpc).toHaveBeenCalledWith(
      "input_request.list",
      expect.objectContaining({ workspaceId: workspaceOne.id, limit: 100, offset: 0 }),
    );
    expect(rpc).toHaveBeenCalledWith(
      "input_request.list",
      expect.objectContaining({ workspaceId: workspaceTwo.id, limit: 100, offset: 0 }),
    );

    rpc.mockClear();
    const scoped = await bridge.methods.listInputRequests({
      taskId: taskTwo.id,
      status: "pending",
    });
    expect(scoped.map((request) => request.id)).toEqual(["223e4567-e89b-42d3-a456-426614174000"]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      "input_request.list",
      expect.objectContaining({ workspaceId: workspaceTwo.id, taskId: taskTwo.id }),
    );
    bridge.dispose();
  });

  it("refreshes the cached scope and sends the server expected version with the response", async () => {
    const current = inputRequest({ requestedAt: 200, expectedVersion: 200 });
    const { bridge, mutate } = createBridge({ inputs: [current] });
    await bridge.methods.listInputRequests({ status: "pending" });
    current.requestedAt = 250;
    current.expectedVersion = 250;

    await bridge.methods.respondToInputRequest({
      requestId: inputId,
      status: "submitted",
      answers: { output_format: { optionLabel: "PDF" } },
    });

    expect(mutate).toHaveBeenCalledWith(
      "input_request.respond",
      expect.objectContaining({
        requestId: inputId,
        workspaceId: workspaceOne.id,
        taskId: taskOne.id,
        expectedVersion: 250,
        status: "submitted",
        answers: { output_format: { optionLabel: "PDF" } },
      }),
      { workspaceId: workspaceOne.id, taskId: taskOne.id, id: inputId, expectedVersion: 250 },
    );
    bridge.dispose();
  });

  it("does not resolve a decision after a refresh confirms the record is no longer pending", async () => {
    const row = approval();
    const { bridge, mutate } = createBridge({ approvals: [row] });
    await bridge.hydrateTaskEvent(
      event("approval_requested", { approvalId: row.id, approval: row }),
    );
    row.status = "approved";

    await expect(
      bridge.methods.respondToApproval({ approvalId: row.id, approved: true }),
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    expect(mutate).not.toHaveBeenCalled();
    bridge.dispose();
  });

  it("hydrates only currently pending records and keeps historical IDs and status without making them actionable", async () => {
    const currentApproval = approval({ expectedVersion: 310, requestedAt: 310 });
    const currentInput = inputRequest({ expectedVersion: 320, requestedAt: 320 });
    const { bridge } = createBridge({ approvals: [currentApproval], inputs: [currentInput] });

    const hydratedApproval = await bridge.hydrateTaskEvent(
      event("approval_requested", {
        approvalId: currentApproval.id,
        approval: { id: currentApproval.id, status: "pending", description: "old text" },
      }),
    );
    expect(hydratedApproval.payload.approval).toMatchObject({
      id: currentApproval.id,
      status: "pending",
      description: "Run the reviewed command",
      expectedVersion: 310,
      workspaceId: workspaceOne.id,
    });

    const hydratedInput = await bridge.hydrateTaskEvent(
      event("input_request_created", { requestId: inputId, request: { id: inputId } }),
    );
    expect(hydratedInput.payload.request).toMatchObject({
      id: inputId,
      status: "pending",
      expectedVersion: 320,
      questions: [{ id: "output_format" }],
    });
    expect(JSON.stringify(hydratedInput.payload.request)).not.toContain("answers");

    const historical = await bridge.hydrateTaskEvent(
      event("approval_requested", {
        approval: { id: "already-resolved", status: "approved", description: "Past approval" },
      }),
    );
    expect(historical.payload.approvalId).toBe("already-resolved");
    expect(historical.payload.approval).toMatchObject({ status: "approved" });
    expect(historical.payload.approval).not.toHaveProperty("id");

    const noLongerPending = await bridge.hydrateTaskEvent(
      event("input_request_created", {
        request: { id: "resolved-input", status: "pending", questions: [] },
      }),
    );
    expect(noLongerPending.payload.requestId).toBe("resolved-input");
    expect(noLongerPending.payload.request).toMatchObject({ status: "pending" });
    expect(noLongerPending.payload.request).not.toHaveProperty("id");
    bridge.dispose();
  });

  it("rejects recurring approval actions with a browser-specific explanation", async () => {
    const { bridge } = createBridge({ approvals: [approval()] });
    await expect(
      bridge.methods.respondToApproval({
        approvalId: "approval-one",
        approved: true,
        action: "allow_recurring",
      }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_CAPABILITY",
      message: expect.stringContaining("one-time approve or deny"),
    });
    bridge.dispose();
  });
});
