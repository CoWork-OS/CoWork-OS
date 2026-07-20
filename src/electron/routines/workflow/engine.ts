import { randomUUID } from "crypto";
import type {
  RoutineWorkflowDefinition,
  RoutineWorkflowNode,
  RoutineWorkflowRunRecord,
  RoutineWorkflowStepRecord,
  WorkflowRiskLevel,
} from "../../../shared/routine-workflow";
import type { Routine } from "../types";
import { DEFAULT_WORKFLOW_LIMITS, getWorkflowOperation } from "./catalog";
import { RoutineWorkflowRepository } from "./repository";
import { validateRoutineWorkflow } from "./validation";
import {
  evaluateWorkflowComparison,
  lookupWorkflowPath,
  resolveWorkflowInputs,
  type WorkflowVariableContext,
} from "./variables";

export interface RoutineWorkflowActionExecutorParams {
  routine: Routine;
  workflow: RoutineWorkflowDefinition;
  node: RoutineWorkflowNode;
  input: Record<string, unknown>;
  runId: string;
  stepId: string;
  dryRun: boolean;
  signal: AbortSignal;
}

export interface RoutineWorkflowEngineOptions {
  executeAction?: (params: RoutineWorkflowActionExecutorParams) => Promise<Record<string, unknown>>;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface StartWorkflowRunInput {
  routine: Routine;
  workflow: RoutineWorkflowDefinition;
  workflowVersionId: string;
  trigger: Record<string, unknown>;
  eventId?: string;
  idempotencyKey?: string;
  dryRun?: boolean;
}

type StoredRunContext = {
  trigger: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
  approvedStepIds: string[];
  dryRun: boolean;
  executedOperationCount: number;
};

type ExecutionBudget = {
  deadline: number;
  remaining: number;
  context: StoredRunContext;
};

const TERMINAL_STEP_STATUSES = new Set(["completed", "failed", "skipped", "cancelled"]);

export class RoutineWorkflowEngine {
  private readonly running = new Set<string>();
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private readonly now: () => number;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly repository: RoutineWorkflowRepository,
    private readonly options: RoutineWorkflowEngineOptions = {},
  ) {
    this.now = options.now || (() => Date.now());
    this.sleep =
      options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async start(input: StartWorkflowRunInput): Promise<RoutineWorkflowRunRecord> {
    const validation = validateRoutineWorkflow(input.workflow, {
      allowIncomplete: Boolean(input.dryRun),
    });
    if (!validation.valid) {
      throw new Error(
        validation.issues
          .filter((issue) => issue.severity === "error")
          .map((issue) => issue.message)
          .join(" "),
      );
    }

    const run = this.repository.createRun({
      routineId: input.routine.id,
      workflowVersionId: input.workflowVersionId,
      triggerNodeId: input.workflow.starterNodeId,
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      context: {
        trigger: structuredClone(input.trigger),
        nodes: { [input.workflow.starterNodeId]: structuredClone(input.trigger) },
        approvedStepIds: [],
        dryRun: Boolean(input.dryRun),
        executedOperationCount: 0,
      } satisfies StoredRunContext,
    });

    const existingSteps = this.repository.listSteps(run.id);
    if (existingSteps.length > 0) {
      if (
        run.status === "completed" ||
        run.status === "partial_success" ||
        run.status === "failed" ||
        run.status === "cancelled" ||
        run.status === "waiting_for_approval"
      ) {
        return run;
      }
      return this.continueRun(input.routine, input.workflow, run.id);
    }

    this.repository.initializeSteps(run.id, input.routine.id, input.workflow.nodes);
    const starterStep = this.repository.findStep(run.id, input.workflow.starterNodeId);
    if (starterStep?.status === "pending") {
      this.repository.updateStep(starterStep.id, {
        status: "completed",
        attemptCount: 1,
        input: input.trigger,
        output: { ...input.trigger, __port: "success" },
        startedAt: this.now(),
        finishedAt: this.now(),
      });
    }
    this.repository.updateRun(run.id, {
      status: "running",
      startedAt: run.startedAt || this.now(),
    });
    return this.continueRun(input.routine, input.workflow, run.id);
  }

  async continueRun(
    routine: Routine,
    workflow: RoutineWorkflowDefinition,
    runId: string,
  ): Promise<RoutineWorkflowRunRecord> {
    if (this.running.has(runId)) return this.requireRun(runId);
    this.running.add(runId);
    try {
      let run = this.requireRun(runId);
      if (run.status === "completed" || run.status === "failed" || run.status === "cancelled")
        return run;
      const limits = { ...DEFAULT_WORKFLOW_LIMITS, ...workflow.settings };
      const deadline = (run.startedAt || this.now()) + limits.maxRunDurationMs;
      const initialContext = this.getContext(run);
      const budget: ExecutionBudget = {
        deadline,
        remaining: Math.max(0, limits.maxStepCount - initialContext.executedOperationCount),
        context: initialContext,
      };

      while (budget.remaining > 0) {
        run = this.requireRun(runId);
        if (run.status === "waiting_for_approval" || run.status === "cancelled") return run;
        if (this.now() > deadline) {
          return this.repository.updateRun(runId, {
            status: "failed",
            error: `Workflow exceeded its ${limits.maxRunDurationMs}ms run limit.`,
            finishedAt: this.now(),
          })!;
        }

        const stepByNode = new Map(
          this.repository.listSteps(runId).map((step) => [step.nodeId, step]),
        );
        const ready = this.findReadyNodes(workflow, stepByNode);
        if (ready.length === 0) {
          const waiting = Array.from(stepByNode.values()).find(
            (step) => step.status === "waiting_for_approval",
          );
          if (waiting) {
            return this.repository.updateRun(runId, { status: "waiting_for_approval" })!;
          }
          const unfinished = Array.from(stepByNode.values()).filter(
            (step) => !TERMINAL_STEP_STATUSES.has(step.status),
          );
          if (unfinished.length > 0) {
            return this.repository.updateRun(runId, {
              status: "failed",
              error:
                "Workflow could not make progress because its graph dependencies are unresolved.",
              finishedAt: this.now(),
            })!;
          }
          return this.finishRun(runId, stepByNode);
        }

        for (const candidate of ready) {
          if (candidate.skip) {
            this.repository.updateStep(candidate.step.id, {
              status: "skipped",
              output: { __port: "skipped" },
              finishedAt: this.now(),
            });
            continue;
          }
          const outcome = await this.executeNode(
            routine,
            workflow,
            runId,
            candidate.node,
            candidate.step,
            budget,
          );
          if (this.requireRun(runId).status === "cancelled") return this.requireRun(runId);
          if (outcome === "waiting_for_approval") return this.requireRun(runId);
          if (outcome === "failed" && candidate.node.onError !== "continue") {
            const failedStep = this.repository.getStep(candidate.step.id);
            return this.repository.updateRun(runId, {
              status: "failed",
              error: failedStep?.error || `${candidate.node.name} failed.`,
              finishedAt: this.now(),
            })!;
          }
        }
      }

      return this.repository.updateRun(runId, {
        status: "failed",
        error: `Workflow exceeded its ${limits.maxStepCount}-step execution limit.`,
        finishedAt: this.now(),
      })!;
    } finally {
      this.running.delete(runId);
    }
  }

  async respondToApproval(input: {
    routine: Routine;
    workflow: RoutineWorkflowDefinition;
    runId: string;
    stepId: string;
    approved: boolean;
  }): Promise<RoutineWorkflowRunRecord> {
    const run = this.requireRun(input.runId);
    const step = this.repository.getStep(input.stepId);
    if (!step || step.runId !== run.id || step.status !== "waiting_for_approval") {
      throw new Error("Workflow approval is no longer pending.");
    }
    if (!input.approved) {
      this.repository.updateStep(step.id, {
        status: "failed",
        error: "User rejected this workflow action.",
        finishedAt: this.now(),
      });
      return this.repository.updateRun(run.id, {
        status: "failed",
        error: "User rejected a required workflow action.",
        finishedAt: this.now(),
      })!;
    }
    const context = this.getContext(run);
    context.approvedStepIds = Array.from(new Set([...context.approvedStepIds, step.id]));
    this.repository.updateStep(step.id, { status: "pending", approvalId: "approved" });
    this.repository.updateRun(run.id, { status: "running", context });
    return this.continueRun(input.routine, input.workflow, run.id);
  }

  cancel(runId: string): RoutineWorkflowRunRecord | null {
    const run = this.repository.getRun(runId);
    if (!run || run.status === "completed" || run.status === "failed" || run.status === "cancelled")
      return run;
    for (const controller of this.activeControllers.get(runId) || []) {
      controller.abort(new Error("Workflow run was cancelled."));
    }
    for (const step of this.repository.listSteps(runId)) {
      if (!TERMINAL_STEP_STATUSES.has(step.status)) {
        this.repository.updateStep(step.id, { status: "cancelled", finishedAt: this.now() });
      }
    }
    return this.repository.updateRun(runId, { status: "cancelled", finishedAt: this.now() });
  }

  recoverInterruptedRun(
    workflow: RoutineWorkflowDefinition,
    runId: string,
  ): RoutineWorkflowRunRecord | null {
    const run = this.repository.getRun(runId);
    if (!run) return null;
    const interrupted = this.repository
      .listSteps(runId)
      .filter((step) => step.status === "running" || step.status === "retrying");
    if (interrupted.length === 0) return run;

    const context = this.getContext(run);
    const interruptedIds = new Set(interrupted.map((step) => step.id));
    context.approvedStepIds = context.approvedStepIds.filter((id) => !interruptedIds.has(id));
    for (const step of interrupted) {
      const node = findWorkflowNode(workflow.nodes, step.nodeId);
      this.repository.updateStep(step.id, {
        status: "waiting_for_approval",
        approvalId: randomUUID(),
        error: node
          ? `${node.name} was interrupted. Its external outcome is unknown; verify it before approving a retry.`
          : "This step was interrupted. Verify its external outcome before approving a retry.",
        finishedAt: undefined,
      });
    }
    return this.repository.updateRun(runId, {
      status: "waiting_for_approval",
      context,
      error: "One or more interrupted steps require outcome verification before retrying.",
      finishedAt: undefined,
    });
  }

  private findReadyNodes(
    workflow: RoutineWorkflowDefinition,
    stepByNode: Map<string, RoutineWorkflowStepRecord>,
  ): Array<{ node: RoutineWorkflowNode; step: RoutineWorkflowStepRecord; skip: boolean }> {
    const candidates: Array<{
      node: RoutineWorkflowNode;
      step: RoutineWorkflowStepRecord;
      skip: boolean;
    }> = [];
    for (const node of workflow.nodes) {
      if (node.id === workflow.starterNodeId) continue;
      const step = stepByNode.get(node.id);
      if (!step || step.status !== "pending") continue;
      const incoming = workflow.edges.filter((edge) => edge.targetNodeId === node.id);
      if (incoming.length === 0) {
        candidates.push({ node, step, skip: true });
        continue;
      }
      const sourceSteps = incoming.map((edge) => ({
        edge,
        step: stepByNode.get(edge.sourceNodeId),
      }));
      if (
        sourceSteps.some((entry) => !entry.step || !TERMINAL_STEP_STATUSES.has(entry.step.status))
      )
        continue;
      const active = sourceSteps.some(({ edge, step: sourceStep }) => {
        if (!sourceStep || sourceStep.status !== "completed") return false;
        const port = String(sourceStep.output?.__port || "success");
        return edge.sourcePort === "always" || String(edge.sourcePort || "success") === port;
      });
      candidates.push({ node, step, skip: !active });
    }
    return candidates;
  }

  private async executeNode(
    routine: Routine,
    workflow: RoutineWorkflowDefinition,
    runId: string,
    node: RoutineWorkflowNode,
    step: RoutineWorkflowStepRecord,
    budget: ExecutionBudget,
  ): Promise<"completed" | "failed" | "waiting_for_approval"> {
    const run = this.requireRun(runId);
    const context = this.getContext(run);
    const variableContext: WorkflowVariableContext = {
      trigger: context.trigger,
      nodes: context.nodes,
      run: { id: run.id, routineId: run.routineId },
    };
    const resolvedInput = resolveWorkflowInputs(node.config, variableContext);
    const approved = context.approvedStepIds.includes(step.id);
    if (!context.dryRun && !approved && this.nodeNeedsApproval(routine, node)) {
      const approvalId =
        step.approvalId && step.approvalId !== "approved" ? step.approvalId : randomUUID();
      this.repository.updateStep(step.id, {
        status: "waiting_for_approval",
        input: redactForStorage(resolvedInput),
        approvalId,
      });
      this.repository.updateRun(runId, { status: "waiting_for_approval" });
      return "waiting_for_approval";
    }

    const nodeRisk = highestNodeRisk(node);
    const retry = {
      maxAttempts:
        nodeRisk === "external_write" || nodeRisk === "data_export"
          ? step.attemptCount + 1
          : Math.max(1, Math.min(10, node.retry?.maxAttempts ?? 1)),
      initialDelayMs: Math.max(0, node.retry?.initialDelayMs ?? 500),
      backoffMultiplier: Math.max(1, node.retry?.backoffMultiplier ?? 2),
      maxDelayMs: Math.max(0, node.retry?.maxDelayMs ?? 10_000),
    };
    let lastError: unknown;
    for (let attempt = step.attemptCount + 1; attempt <= retry.maxAttempts; attempt += 1) {
      this.repository.updateStep(step.id, {
        status: attempt === 1 ? "running" : "retrying",
        attemptCount: attempt,
        input: redactForStorage(resolvedInput),
        error: undefined,
        startedAt: step.startedAt || this.now(),
      });
      const controller = new AbortController();
      this.trackController(runId, controller);
      try {
        const output = await withTimeout(
          this.executeOperation(
            routine,
            workflow,
            runId,
            step.id,
            node,
            resolvedInput,
            variableContext,
            context.dryRun,
            budget,
            controller.signal,
          ),
          Math.max(1_000, node.timeoutMs ?? 120_000),
          `${node.name} timed out.`,
          () => controller.abort(new Error(`${node.name} timed out.`)),
        );
        throwIfAborted(controller.signal);
        const normalizedOutput = { ...output, __port: output.__port || "success" };
        context.nodes[node.id] = redactForStorage(normalizedOutput);
        context.executedOperationCount = budget.context.executedOperationCount;
        this.repository.updateRun(runId, { context });
        this.repository.updateStep(step.id, {
          status: "completed",
          output: redactForStorage(normalizedOutput),
          error: undefined,
          finishedAt: this.now(),
        });
        return "completed";
      } catch (error) {
        lastError = error;
        context.executedOperationCount = budget.context.executedOperationCount;
        this.repository.updateRun(runId, { context });
        if (controller.signal.aborted) break;
        if (attempt < retry.maxAttempts) {
          const delay = Math.min(
            retry.maxDelayMs,
            retry.initialDelayMs * retry.backoffMultiplier ** (attempt - 1),
          );
          if (delay > 0) await this.sleep(delay);
        }
      } finally {
        this.untrackController(runId, controller);
      }
    }
    if (this.repository.getRun(runId)?.status === "cancelled") return "failed";
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    this.repository.updateStep(step.id, {
      status: "failed",
      error: message,
      output: { __port: "error" },
      finishedAt: this.now(),
    });
    return "failed";
  }

  private async executeOperation(
    routine: Routine,
    workflow: RoutineWorkflowDefinition,
    runId: string,
    stepId: string,
    node: RoutineWorkflowNode,
    input: Record<string, unknown>,
    variableContext: WorkflowVariableContext,
    dryRun: boolean,
    budget: ExecutionBudget,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    if (this.now() > budget.deadline) {
      throw new Error("Workflow exceeded its configured run-duration limit.");
    }
    if (budget.remaining <= 0) {
      throw new Error("Workflow exceeded its configured operation-count limit.");
    }
    budget.remaining -= 1;
    budget.context.executedOperationCount += 1;
    if (node.operation === "control.condition") {
      const value = evaluateWorkflowComparison(
        input.left,
        String(input.operator || "equals"),
        input.right,
      );
      return { result: value, __port: value ? "true" : "false" };
    }
    if (node.operation === "control.filter") {
      const items = Array.isArray(input.items) ? input.items : [];
      const path = String(input.path || "");
      const filtered = items.filter((item) => {
        const left = path ? lookupWorkflowPath(`item.${path}`, { ...variableContext, item }) : item;
        return evaluateWorkflowComparison(left, String(input.operator || "equals"), input.value);
      });
      return { items: filtered, count: filtered.length };
    }
    if (node.operation === "control.foreach") {
      const items = Array.isArray(input.items) ? input.items : [];
      const limit = Math.min(
        Number(
          input.maxItems ||
            workflow.settings?.maxForEachItems ||
            DEFAULT_WORKFLOW_LIMITS.maxForEachItems,
        ),
        workflow.settings?.maxForEachItems || DEFAULT_WORKFLOW_LIMITS.maxForEachItems,
      );
      if (items.length > limit)
        throw new Error(`Repeat for each received ${items.length} items; the limit is ${limit}.`);
      const results: unknown[] = [];
      for (const [index, item] of items.entries()) {
        let childResult: Record<string, unknown> = { item, index };
        for (const child of node.children || []) {
          const childInput = resolveWorkflowInputs(child.config, {
            ...variableContext,
            item,
            index,
          });
          childResult = await this.executeOperation(
            routine,
            workflow,
            runId,
            stepId,
            child,
            childInput,
            { ...variableContext, item, index },
            dryRun,
            budget,
            signal,
          );
        }
        results.push(childResult);
      }
      return { items, results, count: results.length };
    }

    if (!this.options.executeAction) {
      if (dryRun)
        return { preview: true, operation: node.operation, input: redactForStorage(input) };
      throw new Error(`No executor is registered for ${node.operation}.`);
    }
    return this.options.executeAction({
      routine,
      workflow,
      node,
      input,
      runId,
      stepId,
      dryRun,
      signal,
    });
  }

  private nodeNeedsApproval(routine: Routine, node: RoutineWorkflowNode): boolean {
    if (node.approvalMode === "always_confirm") return true;
    const risk = highestNodeRisk(node);
    if (risk === "data_export") return true;
    if (node.approvalMode === "never_confirm_safe" && (risk === "read" || risk === "local_write"))
      return false;
    switch (routine.approvalPolicy.mode) {
      case "auto_safe":
        return risk === "external_write";
      case "strict_confirm":
        return risk !== "read";
      case "confirm_external":
      case "inherit":
        return risk === "external_write";
    }
  }

  private finishRun(
    runId: string,
    stepByNode: Map<string, RoutineWorkflowStepRecord>,
  ): RoutineWorkflowRunRecord {
    const context = this.getContext(this.requireRun(runId));
    const failed = Array.from(stepByNode.values()).filter((step) => step.status === "failed");
    return this.repository.updateRun(runId, {
      status: failed.length > 0 ? "partial_success" : "completed",
      output: context.nodes,
      error:
        failed.length > 0
          ? failed
              .map((step) => step.error)
              .filter(Boolean)
              .join("; ")
          : undefined,
      finishedAt: this.now(),
    })!;
  }

  private requireRun(runId: string): RoutineWorkflowRunRecord {
    const run = this.repository.getRun(runId);
    if (!run) throw new Error(`Workflow run not found: ${runId}`);
    return run;
  }

  private getContext(run: RoutineWorkflowRunRecord): StoredRunContext {
    const raw = run.context || {};
    return {
      trigger: isRecord(raw.trigger) ? raw.trigger : {},
      nodes: isRecord(raw.nodes) ? (raw.nodes as Record<string, Record<string, unknown>>) : {},
      approvedStepIds: Array.isArray(raw.approvedStepIds)
        ? raw.approvedStepIds.filter((value): value is string => typeof value === "string")
        : [],
      dryRun: Boolean(raw.dryRun),
      executedOperationCount: Number.isFinite(Number(raw.executedOperationCount))
        ? Math.max(0, Number(raw.executedOperationCount))
        : 0,
    };
  }

  private trackController(runId: string, controller: AbortController): void {
    const controllers = this.activeControllers.get(runId) || new Set<AbortController>();
    controllers.add(controller);
    this.activeControllers.set(runId, controllers);
  }

  private untrackController(runId: string, controller: AbortController): void {
    const controllers = this.activeControllers.get(runId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this.activeControllers.delete(runId);
  }
}

function highestNodeRisk(node: RoutineWorkflowNode): WorkflowRiskLevel {
  const order: WorkflowRiskLevel[] = ["read", "local_write", "external_write", "data_export"];
  const risks = [getWorkflowOperation(node.operation)?.risk || "external_write"];
  for (const child of node.children || []) risks.push(highestNodeRisk(child));
  return risks.reduce(
    (highest, risk) => (order.indexOf(risk) > order.indexOf(highest) ? risk : highest),
    "read",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function redactForStorage(value: Record<string, unknown>): Record<string, unknown> {
  const sensitive = /token|secret|password|authorization|api[_-]?key/i;
  const visit = (input: unknown, depth = 0): unknown => {
    if (depth > 8) return "[truncated]";
    if (Array.isArray(input)) return input.slice(0, 200).map((item) => visit(item, depth + 1));
    if (!isRecord(input)) return input;
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => [
        key,
        sensitive.test(key) ? "[redacted]" : visit(child, depth + 1),
      ]),
    );
  };
  return visit(value) as Record<string, unknown>;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow action was cancelled.");
}

function findWorkflowNode(
  nodes: RoutineWorkflowNode[],
  nodeId: string,
): RoutineWorkflowNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const child = findWorkflowNode(node.children || [], nodeId);
    if (child) return child;
  }
  return undefined;
}
