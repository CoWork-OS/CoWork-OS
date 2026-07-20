import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineWorkflowDefinition } from "../../../../shared/routine-workflow";
import type { Routine } from "../../types";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("RoutineWorkflowEngine", () => {
  let db: import("better-sqlite3").Database;
  let Repository: typeof import("../repository").RoutineWorkflowRepository;
  let Engine: typeof import("../engine").RoutineWorkflowEngine;
  let routine: Routine;

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");
    ({ RoutineWorkflowRepository: Repository } = await import("../repository"));
    ({ RoutineWorkflowEngine: Engine } = await import("../engine"));
    routine = {
      id: "routine-1",
      name: "Workflow",
      enabled: true,
      workspaceId: "workspace-1",
      instructions: "Run workflow",
      prompt: "Run workflow",
      connectors: [],
      executionTarget: { kind: "workspace" },
      contextBindings: {},
      triggers: [{ id: "manual", type: "manual", enabled: true }],
      outputs: [{ kind: "task_only" }],
      approvalPolicy: { mode: "auto_safe" },
      connectorPolicy: { mode: "prefer", connectorIds: [] },
      createdAt: 1,
      updatedAt: 1,
    };
  });

  it("executes a sequence with typed output references", async () => {
    const executeAction = vi.fn(async ({ node, input }) =>
      node.operation === "ai.summarize"
        ? { text: `Summary: ${input.input}` }
        : { received: input.text },
    );
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction });
    const definition = sequenceWorkflow();

    const run = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: { body: "Quarterly details" },
      idempotencyKey: "sequence-1",
    });

    expect(run.status).toBe("completed");
    expect(executeAction).toHaveBeenCalledTimes(2);
    expect(executeAction.mock.calls[1][0].input.text).toBe("Summary: Quarterly details");
  });

  it("routes condition branches and skips the inactive branch", async () => {
    const executeAction = vi.fn(async ({ node }) => ({ chosen: node.id }));
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction });
    const definition: RoutineWorkflowDefinition = {
      version: 1,
      starterNodeId: "starter",
      nodes: [
        { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
        {
          id: "check",
          kind: "condition",
          operation: "control.condition",
          name: "Check",
          config: { left: { $ref: "trigger.priority" }, operator: "equals", right: "high" },
        },
        {
          id: "yes",
          kind: "agent",
          operation: "agent.run",
          name: "High",
          config: { prompt: "High" },
        },
        {
          id: "no",
          kind: "agent",
          operation: "agent.run",
          name: "Normal",
          config: { prompt: "Normal" },
        },
      ],
      edges: [
        { id: "one", sourceNodeId: "starter", targetNodeId: "check" },
        { id: "two", sourceNodeId: "check", targetNodeId: "yes", sourcePort: "true" },
        { id: "three", sourceNodeId: "check", targetNodeId: "no", sourcePort: "false" },
      ],
    };

    const run = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: { priority: "normal" },
    });
    const steps = repository.listSteps(run.id);

    expect(steps.find((step) => step.nodeId === "yes")?.status).toBe("skipped");
    expect(steps.find((step) => step.nodeId === "no")?.status).toBe("completed");
  });

  it("pauses an external write for approval and resumes once", async () => {
    routine.approvalPolicy = { mode: "confirm_external" };
    const executeAction = vi.fn(async () => ({ messageId: "message-1" }));
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction });
    const definition: RoutineWorkflowDefinition = {
      version: 1,
      starterNodeId: "starter",
      nodes: [
        { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
        {
          id: "email",
          kind: "action",
          operation: "gmail.notify",
          name: "Email",
          config: { to: "ops@example.com", subject: "Review", body: "Ready" },
        },
      ],
      edges: [{ id: "edge", sourceNodeId: "starter", targetNodeId: "email" }],
    };

    const waiting = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: {},
    });
    const step = repository.findStep(waiting.id, "email")!;
    const completed = await engine.respondToApproval({
      routine,
      workflow: definition,
      runId: waiting.id,
      stepId: step.id,
      approved: true,
    });

    expect(waiting.status).toBe("waiting_for_approval");
    expect(completed.status).toBe("completed");
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it("requires approval for external writes under auto-safe", async () => {
    const executeAction = vi.fn(async () => ({ messageId: "message-1" }));
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction });
    const definition = externalWriteWorkflow();

    const run = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: {},
    });

    expect(run.status).toBe("waiting_for_approval");
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("does not automatically retry external writes", async () => {
    routine.approvalPolicy = { mode: "confirm_external" };
    const executeAction = vi.fn(async () => {
      throw new Error("outcome unknown");
    });
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction, sleep: async () => undefined });
    const definition = externalWriteWorkflow();
    definition.nodes[1].retry = { maxAttempts: 3, initialDelayMs: 1 };
    const waiting = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: {},
    });
    const step = repository.findStep(waiting.id, "email")!;

    const failed = await engine.respondToApproval({
      routine,
      workflow: definition,
      runId: waiting.id,
      stepId: step.id,
      approved: true,
    });

    expect(failed.status).toBe("failed");
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it("aborts an active action when the run is cancelled", async () => {
    routine.approvalPolicy = { mode: "auto_safe" };
    let observedSignal: AbortSignal | undefined;
    const executeAction = vi.fn(
      ({ signal }: Any) =>
        new Promise<Record<string, unknown>>((_resolve, reject) => {
          observedSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction });
    const definition = sequenceWorkflow();
    definition.nodes = definition.nodes.slice(0, 2);
    definition.edges = definition.edges.slice(0, 1);
    const startPromise = engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: { body: "cancel" },
    });
    await vi.waitFor(() => expect(repository.listRuns()[0]?.status).toBe("running"));

    engine.cancel(repository.listRuns()[0].id);
    const run = await startPromise;

    expect(observedSignal?.aborted).toBe(true);
    expect(run.status).toBe("cancelled");
  });

  it("redacts sensitive action output from durable run context", async () => {
    const repository = new Repository(db);
    const engine = new Engine(repository, {
      executeAction: vi.fn(async () => ({ apiKey: "secret-value", text: "safe" })),
    });
    const definition = sequenceWorkflow();
    definition.nodes = definition.nodes.slice(0, 2);
    definition.edges = definition.edges.slice(0, 1);

    const run = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: { body: "redact" },
    });

    expect((run.output?.summary as Any)?.apiKey).toBe("[redacted]");
  });

  it("recovers an interrupted step into explicit outcome verification", () => {
    const repository = new Repository(db);
    const engine = new Engine(repository);
    const definition = externalWriteWorkflow();
    const run = repository.createRun({
      routineId: routine.id,
      workflowVersionId: "version-1",
      triggerNodeId: "starter",
      context: { trigger: {}, nodes: {}, approvedStepIds: ["unused"], dryRun: false },
    });
    repository.initializeSteps(run.id, routine.id, definition.nodes);
    const step = repository.findStep(run.id, "email")!;
    repository.updateStep(step.id, { status: "running", attemptCount: 1 });
    repository.updateRun(run.id, { status: "running", startedAt: 1 });

    const recovered = engine.recoverInterruptedRun(definition, run.id);

    expect(recovered?.status).toBe("waiting_for_approval");
    expect(repository.getStep(step.id)?.status).toBe("waiting_for_approval");
  });

  it("counts nested loop actions against the total operation budget", async () => {
    const executeAction = vi.fn(async () => ({ ok: true }));
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction });
    const definition: RoutineWorkflowDefinition = {
      version: 1,
      starterNodeId: "starter",
      settings: { maxStepCount: 3 },
      nodes: [
        { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
        {
          id: "loop",
          kind: "foreach",
          operation: "control.foreach",
          name: "Loop",
          config: { items: [1, 2, 3] },
          children: [
            {
              id: "summarize-child",
              kind: "ai",
              operation: "ai.summarize",
              name: "Summarize child",
              config: { input: { $ref: "item" } },
            },
          ],
        },
      ],
      edges: [{ id: "edge", sourceNodeId: "starter", targetNodeId: "loop" }],
    };

    const run = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: {},
    });

    expect(run.status).toBe("failed");
    expect(executeAction).toHaveBeenCalledTimes(2);
  });

  it("retries a failed read action and preserves idempotency", async () => {
    let attempts = 0;
    const executeAction = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary");
      return { ok: true };
    });
    const repository = new Repository(db);
    const engine = new Engine(repository, { executeAction, sleep: async () => undefined });
    const definition = sequenceWorkflow();
    definition.nodes = definition.nodes.slice(0, 2);
    definition.edges = definition.edges.slice(0, 1);
    definition.nodes[1].retry = { maxAttempts: 2, initialDelayMs: 1 };

    const first = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: { body: "retry" },
      idempotencyKey: "same-event",
    });
    const duplicate = await engine.start({
      routine,
      workflow: definition,
      workflowVersionId: "version-1",
      trigger: { body: "retry" },
      idempotencyKey: "same-event",
    });

    expect(first.status).toBe("completed");
    expect(duplicate.id).toBe(first.id);
    expect(executeAction).toHaveBeenCalledTimes(2);
  });
});

function sequenceWorkflow(): RoutineWorkflowDefinition {
  return {
    version: 1,
    starterNodeId: "starter",
    nodes: [
      { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
      {
        id: "summary",
        kind: "ai",
        operation: "ai.summarize",
        name: "Summarize",
        config: { input: { $ref: "trigger.body" } },
      },
      {
        id: "agent",
        kind: "agent",
        operation: "agent.run",
        name: "Continue",
        config: { prompt: "Continue", text: { $ref: "summary.text" } },
      },
    ],
    edges: [
      { id: "first", sourceNodeId: "starter", targetNodeId: "summary" },
      { id: "second", sourceNodeId: "summary", targetNodeId: "agent" },
    ],
  };
}

function externalWriteWorkflow(): RoutineWorkflowDefinition {
  return {
    version: 1,
    starterNodeId: "starter",
    nodes: [
      { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
      {
        id: "email",
        kind: "action",
        operation: "gmail.notify",
        name: "Email",
        config: { to: "ops@example.com", subject: "Review", body: "Ready" },
      },
    ],
    edges: [{ id: "edge", sourceNodeId: "starter", targetNodeId: "email" }],
  };
}
