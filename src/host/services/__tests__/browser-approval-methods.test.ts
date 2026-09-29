import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest, InputRequest, Task, Workspace } from "../../../shared/types";
import {
  createBrowserApprovalMethods,
  type BrowserApprovalCommands,
  type BrowserApprovalSources,
} from "../browser-approval-methods";

const workspace = { id: "workspace-1", name: "Work", isTemp: false } as Workspace;
const otherWorkspace = { id: "workspace-2", name: "Other", isTemp: false } as Workspace;
const task = {
  id: "task-1",
  workspaceId: workspace.id,
  title: "Review invoice",
  status: "blocked",
  prompt: "private task prompt",
} as Task;
const otherTask = {
  id: "task-2",
  workspaceId: otherWorkspace.id,
  title: "Other task",
  status: "executing",
} as Task;
const approvalId = "approval-1";
const requestId = "123e4567-e89b-42d3-a456-426614174000";
const requestedAt = 1710000000000;

const approval = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest =>
  ({
    id: approvalId,
    taskId: task.id,
    type: "run_command",
    description: "Run the reviewed command",
    details: { prompt: "private detail", apiKey: "private-key", command: "npm run build" },
    status: "pending",
    requestedAt,
    ...overrides,
  }) as ApprovalRequest;

const inputRequest = (overrides: Partial<InputRequest> = {}): InputRequest =>
  ({
    id: requestId,
    taskId: task.id,
    questions: [
      {
        header: "Output",
        id: "output_format",
        question: "Which format should I use?",
        options: [
          { label: "PDF", description: "Portable document" },
          { label: "DOCX", description: "Editable document" },
        ],
      },
    ],
    status: "pending",
    requestedAt,
    ...overrides,
  }) as InputRequest;

const context = {
  audience: "control-plane",
  identity: {
    installationId: "installation-1",
    profileId: "profile-1",
    generation: "generation-1",
    runtime: "node" as const,
    platform: "linux" as const,
    appVersion: "1.0.0",
  },
  sessionId: "session-1",
  operationKey: "decision-12345678",
};

function sources(): BrowserApprovalSources & {
  commands: BrowserApprovalCommands;
} {
  return {
    getWorkspace: vi.fn(async (workspaceId: string) => {
      if (workspaceId === workspace.id) return workspace;
      if (workspaceId === otherWorkspace.id) return otherWorkspace;
      return null;
    }),
    getTask: vi.fn(async (taskId: string) => {
      if (taskId === task.id) return task;
      if (taskId === otherTask.id) return otherTask;
      return null;
    }),
    listPendingApprovals: vi.fn(async () => [approval()]),
    getApproval: vi.fn(async (id: string) => (id === approvalId ? approval() : null)),
    listPendingInputRequests: vi.fn(async () => [
      inputRequest({ answers: { old: { otherText: "secret answer" } } }),
    ]),
    getInputRequest: vi.fn(async (id: string) =>
      id === requestId
        ? inputRequest({ answers: { output_format: { otherText: "secret answer" } } })
        : null,
    ),
    commands: {
      respondToApproval: vi.fn(async () => "handled"),
      respondToInputRequest: vi.fn(async ({ requestId: id }) => ({
        status: "handled",
        requestId: id,
      })),
    },
  };
}

describe("browser approval and input methods", () => {
  it("lists pending items only in the requested workspace and omits private fields and answers", async () => {
    const dependency = sources();
    vi.mocked(dependency.listPendingApprovals).mockResolvedValue([
      approval(),
      approval({ id: "approval-other", taskId: otherTask.id }),
    ]);
    vi.mocked(dependency.listPendingInputRequests).mockResolvedValue([
      inputRequest({ answers: { output_format: { otherText: "secret answer" } } }),
      inputRequest({ id: "other-request", taskId: otherTask.id }),
    ]);
    const methods = createBrowserApprovalMethods(dependency);

    const approvalResult = await methods["approval.list"].handler(
      context,
      methods["approval.list"].validateParams!({ workspaceId: workspace.id }),
    );
    const inputResult = await methods["input_request.list"].handler(
      context,
      methods["input_request.list"].validateParams!({ workspaceId: workspace.id }),
    );

    expect(approvalResult).toMatchObject({
      approvals: [{ id: approvalId, expectedVersion: requestedAt }],
    });
    expect(inputResult).toMatchObject({
      inputRequests: [{ id: requestId, expectedVersion: requestedAt }],
    });
    expect(JSON.stringify(approvalResult)).not.toContain("private task prompt");
    expect(JSON.stringify(approvalResult)).not.toContain("private detail");
    expect(JSON.stringify(approvalResult)).not.toContain("private-key");
    expect(JSON.stringify(inputResult)).not.toContain("secret answer");
  });

  it("resolves an exact approval and reconciles the durable decision without exposing details", async () => {
    const dependency = sources();
    let saved = approval();
    vi.mocked(dependency.getApproval).mockImplementation(async (id) =>
      id === approvalId ? saved : null,
    );
    vi.mocked(dependency.commands.respondToApproval).mockImplementation(async () => {
      saved = approval({ status: "approved", resolvedAt: requestedAt + 5 });
      return "handled";
    });
    const methods = createBrowserApprovalMethods(dependency);
    const params = methods["approval.respond"].validateParams!({
      approvalId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      approved: true,
    });

    const result = await methods["approval.respond"].handler(context, params);
    const outcome = await methods["approval.get"].handler(
      context,
      methods["approval.get"].validateParams!({
        approvalId,
        workspaceId: workspace.id,
        taskId: task.id,
        expectedVersion: requestedAt,
      }),
    );

    expect(result).toEqual({ status: "handled", approvalId, decision: "approved" });
    expect(outcome).toMatchObject({ approval: { status: "approved", decision: "approved" } });
    expect(JSON.stringify(outcome)).not.toContain("command");
    expect(dependency.commands.respondToApproval).toHaveBeenCalledWith(approvalId, true);
  });

  it("returns the durable input status without echoing submitted answers", async () => {
    const dependency = sources();
    let saved = inputRequest();
    vi.mocked(dependency.getInputRequest).mockImplementation(async (id) =>
      id === requestId ? saved : null,
    );
    vi.mocked(dependency.commands.respondToInputRequest).mockImplementation(async (response) => {
      saved = inputRequest({
        status: response.status,
        answers: response.answers,
        resolvedAt: requestedAt + 9,
      });
      return { status: "handled", requestId };
    });
    const methods = createBrowserApprovalMethods(dependency);
    const params = methods["input_request.respond"].validateParams!({
      requestId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      status: "submitted",
      answers: { output_format: { optionLabel: "PDF" } },
    });

    const result = await methods["input_request.respond"].handler(context, params);
    const outcome = await methods["input_request.get"].handler(
      context,
      methods["input_request.get"].validateParams!({
        requestId,
        workspaceId: workspace.id,
        taskId: task.id,
        expectedVersion: requestedAt,
      }),
    );

    expect(result).toEqual({ status: "handled", requestId, decision: "submitted" });
    expect(outcome).toMatchObject({
      inputRequest: { status: "submitted", decision: "submitted", resolvedAt: requestedAt + 9 },
    });
    expect(JSON.stringify(result)).not.toContain("PDF");
    expect(JSON.stringify(outcome)).not.toContain("answers");
    expect(JSON.stringify(outcome)).not.toContain("secret answer");
  });

  it("rejects stale, cross-workspace, and opposite decisions before invoking a resolver", async () => {
    const dependency = sources();
    const methods = createBrowserApprovalMethods(dependency);
    const respond = methods["approval.respond"];

    await expect(
      respond.handler(
        context,
        respond.validateParams!({
          approvalId,
          workspaceId: workspace.id,
          taskId: task.id,
          expectedVersion: requestedAt - 1,
          approved: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "STALE_STATE" });
    await expect(
      respond.handler(
        context,
        respond.validateParams!({
          approvalId,
          workspaceId: otherWorkspace.id,
          taskId: otherTask.id,
          expectedVersion: requestedAt,
          approved: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    vi.mocked(dependency.getApproval).mockResolvedValueOnce(approval({ status: "approved" }));
    await expect(
      respond.handler(
        { ...context, operationKey: "opposite-vote-1234" },
        respond.validateParams!({
          approvalId,
          workspaceId: workspace.id,
          taskId: task.id,
          expectedVersion: requestedAt,
          approved: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(dependency.commands.respondToApproval).not.toHaveBeenCalled();
  });

  it("reuses a same-key result and rejects a changed decision under that key", async () => {
    const dependency = sources();
    let saved = approval();
    vi.mocked(dependency.getApproval).mockImplementation(async () => saved);
    vi.mocked(dependency.commands.respondToApproval).mockImplementation(async () => {
      saved = approval({ status: "approved" });
      return "handled";
    });
    const methods = createBrowserApprovalMethods(dependency);
    const respond = methods["approval.respond"];
    const approved = respond.validateParams!({
      approvalId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      approved: true,
    });

    const first = await respond.handler(context, approved);
    const retry = await respond.handler(context, approved);
    await expect(
      respond.handler(
        context,
        respond.validateParams!({
          approvalId,
          workspaceId: workspace.id,
          taskId: task.id,
          expectedVersion: requestedAt,
          approved: false,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(first).toEqual(retry);
    expect(dependency.commands.respondToApproval).toHaveBeenCalledTimes(1);
  });

  it("returns a retryable unknown outcome when the durable row remains pending", async () => {
    const dependency = sources();
    vi.mocked(dependency.commands.respondToApproval).mockResolvedValue("handled");
    const methods = createBrowserApprovalMethods(dependency);
    const respond = methods["approval.respond"];

    await expect(
      respond.handler(
        context,
        respond.validateParams!({
          approvalId,
          workspaceId: workspace.id,
          taskId: task.id,
          expectedVersion: requestedAt,
          approved: true,
        }),
      ),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN", retryable: true });
  });

  it("rejects answers that do not match the persisted question options", async () => {
    const dependency = sources();
    const methods = createBrowserApprovalMethods(dependency);
    const respond = methods["input_request.respond"];
    const params = respond.validateParams!({
      requestId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      status: "submitted",
      answers: { output_format: { optionLabel: "CSV" } },
    });

    await expect(respond.handler(context, params)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(dependency.commands.respondToInputRequest).not.toHaveBeenCalled();
  });

  it("requires exactly one answer for every persisted question ID", async () => {
    const dependency = sources();
    const questions = [
      inputRequest().questions[0]!,
      {
        header: "Name",
        id: "file_name",
        question: "What should the file be called?",
        options: [{ label: "Report", description: "Use a report name" }],
      },
    ];
    vi.mocked(dependency.getInputRequest).mockResolvedValue(inputRequest({ questions }));
    const respond = createBrowserApprovalMethods(dependency)["input_request.respond"];
    const base = {
      requestId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      status: "submitted",
    };

    await expect(
      respond.handler(
        context,
        respond.validateParams!({ ...base, answers: { output_format: { optionLabel: "PDF" } } }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      respond.handler(
        context,
        respond.validateParams!({
          ...base,
          answers: {
            output_format: { optionLabel: "PDF" },
            unexpected: { otherText: "Report" },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(dependency.commands.respondToInputRequest).not.toHaveBeenCalled();
  });

  it("requires exactly one of optionLabel or otherText per answer", () => {
    const respond = createBrowserApprovalMethods(sources())["input_request.respond"];
    const base = {
      requestId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      status: "submitted",
    };

    expect(() =>
      respond.validateParams!({
        ...base,
        answers: { output_format: { optionLabel: "PDF", otherText: "extra value" } },
      }),
    ).toThrow();
    expect(() => respond.validateParams!({ ...base, answers: { output_format: {} } })).toThrow();
    expect(() => respond.validateParams!(base)).toThrow();
  });

  it("keeps dismissal as a skip with no answer object", async () => {
    const dependency = sources();
    let saved = inputRequest();
    vi.mocked(dependency.getInputRequest).mockImplementation(async (id) =>
      id === requestId ? saved : null,
    );
    vi.mocked(dependency.commands.respondToInputRequest).mockImplementation(async (response) => {
      saved = inputRequest({ status: response.status, resolvedAt: requestedAt + 9 });
      return { status: "handled", requestId };
    });
    const respond = createBrowserApprovalMethods(dependency)["input_request.respond"];
    const params = respond.validateParams!({
      requestId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      status: "dismissed",
    });

    await expect(respond.handler(context, params)).resolves.toEqual({
      status: "handled",
      requestId,
      decision: "dismissed",
    });
    expect(dependency.commands.respondToInputRequest).toHaveBeenCalledWith({
      requestId,
      status: "dismissed",
    });
  });

  it("rejects free-text answers above the browser field limit", () => {
    const methods = createBrowserApprovalMethods(sources());
    expect(() =>
      methods["input_request.respond"].validateParams!({
        requestId,
        workspaceId: workspace.id,
        taskId: task.id,
        expectedVersion: requestedAt,
        status: "submitted",
        answers: { output_format: { otherText: "x".repeat(8_001) } },
      }),
    ).toThrow();
  });

  it("allows a free-text answer without echoing the text", async () => {
    const dependency = sources();
    let saved = inputRequest({
      questions: [
        {
          header: "Output",
          id: "output_format",
          question: "Which format should I use?",
          options: [
            { label: "PDF", description: "Portable document" },
            { label: "Other", description: "Specify a format" },
          ],
        },
      ],
    });
    vi.mocked(dependency.getInputRequest).mockImplementation(async (id) =>
      id === requestId ? saved : null,
    );
    vi.mocked(dependency.commands.respondToInputRequest).mockImplementation(async (response) => {
      saved = inputRequest({
        status: response.status,
        answers: response.answers,
        resolvedAt: requestedAt + 9,
      });
      return { status: "handled", requestId };
    });
    const methods = createBrowserApprovalMethods(dependency);
    const respond = methods["input_request.respond"];
    const privateAnswer = "customer secret value";
    const params = respond.validateParams!({
      requestId,
      workspaceId: workspace.id,
      taskId: task.id,
      expectedVersion: requestedAt,
      status: "submitted",
      answers: { output_format: { otherText: privateAnswer } },
    });

    const result = await respond.handler(context, params);

    expect(result).toEqual({ status: "handled", requestId, decision: "submitted" });
    expect(dependency.commands.respondToInputRequest).toHaveBeenCalledWith({
      requestId,
      status: "submitted",
      answers: { output_format: { otherText: privateAnswer } },
    });
    expect(JSON.stringify(result)).not.toContain(privateAnswer);
  });
});
