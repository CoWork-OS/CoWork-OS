import { randomUUID } from "node:crypto";
import { snapshotToolInput } from "../agent/tools/tool-input-snapshot";
import {
  ApplicationOperationRequestSchema,
  ApplicationPreparedChangeSchema,
  ApplicationResultSchema,
  ApplicationVerificationSchema,
  projectApplicationOperation,
  type ApplicationOperation,
  type ApplicationOperationRequest,
  type ApplicationAttempt,
} from "../../shared/application-execution";
import {
  ApplicationAdapterCatalog,
  ApplicationNotDispatchedError,
  type ApplicationAdapter,
  type ApplicationAdapterContext,
  type ApplicationAdapterOutcome,
  type ApplicationToolGateway,
} from "./ApplicationAdapterCatalog";
import { ApplicationOperationRepository } from "./ApplicationOperationRepository";
import {
  applicationDecisionBinding,
  applicationJson,
  type ApplicationOperationUpdate,
} from "./application-operation-store";

export interface ApplicationExecutionHooks {
  changed?(operation: ApplicationOperation): void;
  warning?(error: unknown): void;
}

/** An extension of the existing harness: this owns business operations, not another agent loop. */
export class ApplicationExecutionService {
  readonly catalog = new ApplicationAdapterCatalog();
  private readonly owner = randomUUID();
  private readonly active = new Map<string, AbortController>();
  private readonly inFlight = new Set<Promise<ApplicationOperation>>();
  private readonly cancelledTasks = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private workerRun?: Promise<void>;
  constructor(
    readonly repository: ApplicationOperationRepository,
    private readonly tools: ApplicationToolGateway,
    private readonly hooks: ApplicationExecutionHooks = {},
    private readonly options: {
      now?: () => number;
      leaseMs?: number;
      timeoutMs?: number;
      pollMs?: number;
    } = {},
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private notify(operation: ApplicationOperation): ApplicationOperation {
    try {
      this.hooks.changed?.(operation);
    } catch (error) {
      this.hooks.warning?.(error);
    }
    return operation;
  }
  async get(id: string): Promise<ApplicationOperation> {
    const operation = await this.repository.get(id);
    if (!operation) throw new Error("Application operation not found");
    return operation;
  }
  async create(input: ApplicationOperationRequest): Promise<ApplicationOperation> {
    const request = ApplicationOperationRequestSchema.parse(input);
    if (this.cancelledTasks.has(request.taskId))
      throw new ApplicationNotDispatchedError("Application task was cancelled");
    if (
      request.constraints.deadlineAt !== undefined &&
      request.constraints.deadlineAt <= this.now()
    )
      throw new Error("Application deadline has passed");
    if (request.constraints.maxCost !== undefined && !request.constraints.currency)
      throw new Error("Application cost budget requires a currency");
    const adapter = this.catalog.resolve(request);
    let operation = await this.repository.create(request, adapter.route, this.now());
    if (this.cancelledTasks.has(request.taskId))
      operation = await this.repository.requestCancel(operation.id, this.now());
    if (request.supersedes) this.notify(await this.get(request.supersedes));
    return this.notify(operation);
  }
  async prepare(id: string): Promise<ApplicationOperation> {
    const operation = await this.get(id);
    if (this.cancelledTasks.has(operation.request.taskId)) return operation;
    if (operation.execution !== "planned") return operation;
    const adapter = this.catalog.forOperation(operation);
    if (
      adapter.prepare &&
      operation.request.constraints.maxCost !== undefined &&
      adapter.route.preparationEffect !== "read"
    )
      throw new ApplicationNotDispatchedError(
        "Effectful preparation requires an adapter with a separately bounded preparation cost",
      );
    return this.perform(operation, "prepare", adapter, async (context) => {
      const prepared = ApplicationPreparedChangeSchema.parse(
        adapter.prepare
          ? await adapter.prepare(context)
          : {
              kind: "summary",
              summary: `Proposed operation: ${operation.request.objective}. No application preview was executed.`,
              references: [],
            },
      );
      applicationJson(prepared, true);
      const next = { ...context.operation, prepared };
      return {
        execution: "prepared",
        prepared,
        ...(operation.request.decision
          ? {
              decision: {
                id: randomUUID(),
                operationId: id,
                binding: applicationDecisionBinding(next),
                status: "pending" as const,
                ...operation.request.decision,
              },
            }
          : {}),
      };
    });
  }
  async execute(id: string): Promise<ApplicationOperation> {
    const current = await this.get(id);
    if (this.cancelledTasks.has(current.request.taskId)) return current;
    let operation = await this.repository.requestExecute(id, this.now());
    if (operation.execution === "completed")
      return operation.verification === "pending" ? this.verify(id) : operation;
    if (!["planned", "prepared"].includes(operation.execution)) return operation;
    const adapter = this.catalog.forOperation(operation);
    if (
      operation.execution === "planned" &&
      (adapter.prepare ||
        operation.request.decision ||
        operation.request.constraints.maxCost !== undefined)
    )
      operation = await this.prepare(id);
    if (operation.decision && operation.decision.status !== "accepted") return operation;
    operation = await this.perform(operation, "execute", adapter, async (context) =>
      this.outcome(context, await adapter.execute(context), false),
    );
    return operation.execution === "completed" && operation.verification === "pending"
      ? this.verify(id)
      : operation;
  }
  async reconcile(id: string): Promise<ApplicationOperation> {
    const operation = await this.get(id);
    if (operation.execution === "completed") return this.verify(id, true);
    if (!["running", "unknown", "submitting"].includes(operation.execution)) return operation;
    const adapter = this.catalog.forOperation(operation);
    if (!adapter.observe) return operation;
    const next = await this.perform(operation, "observe", adapter, async (context) =>
      this.outcome(context, await adapter.observe!(context), true),
    );
    return next.execution === "completed" && next.verification === "pending"
      ? this.verify(id)
      : next;
  }
  async verify(id: string, refresh = false): Promise<ApplicationOperation> {
    const operation = await this.get(id);
    if (operation.execution !== "completed" || (!refresh && operation.verification !== "pending"))
      return operation;
    const adapter = this.catalog.forOperation(operation);
    return this.perform(operation, "verify", adapter, async (context) => {
      const verification = ApplicationVerificationSchema.parse(
        adapter.verify
          ? await adapter.verify(context)
          : {
              status: "unavailable",
              summary: "This adapter has no qualified domain verifier.",
              checkedAt: this.now(),
              evidence: [],
            },
      );
      if (
        verification.checkedAt > this.now() ||
        (verification.expiresAt !== undefined && verification.expiresAt <= this.now()) ||
        (verification.status === "verified" &&
          (!(verification.result ?? context.operation.result) ||
            verification.evidence.length === 0))
      )
        throw new Error("Application verifier returned missing or stale evidence");
      return {
        execution: "completed",
        verification: verification.status,
        verificationResult: verification,
        ...(verification.result ? { result: verification.result } : {}),
        error: undefined,
      };
    });
  }
  async cancel(id: string): Promise<ApplicationOperation> {
    let operation = this.notify(await this.repository.requestCancel(id, this.now()));
    this.active
      .get(id)
      ?.abort(new Error("Application cancellation requested; reconcile outstanding effects"));
    if (operation.cancellation !== "requested") return operation;
    if (operation.pendingAction === "cancel") return this.reconcile(id);
    // Do not revoke a local lease and dispatch a second action while execute is still in flight.
    if (this.active.has(id)) return operation;
    const adapter = this.catalog.forOperation(operation);
    if (!adapter.cancel) return operation;
    operation = await this.perform(operation, "cancel", adapter, async (context) => {
      const cancellation = await adapter.cancel!(context);
      return {
        execution: cancellation.confirmed ? "cancelled" : context.operation.execution,
        cancellation: cancellation.confirmed ? "confirmed" : "requested",
        error: cancellation.summary,
        nextPollAt: this.now() + (this.options.pollMs ?? 5_000),
      };
    });
    return operation;
  }
  isTaskCancellationRequested(taskId: string): boolean {
    return this.cancelledTasks.has(taskId);
  }
  resetTaskCancellation(taskId: string): void {
    this.cancelledTasks.delete(taskId);
  }
  async cancelForTask(taskId: string): Promise<void> {
    this.cancelledTasks.add(taskId);
    for (const operation of await this.repository.list(taskId, 500)) {
      this.notify(await this.repository.requestCancel(operation.id, this.now()));
      this.active
        .get(operation.id)
        ?.abort(new Error("Task cancelled; reconcile outstanding application effects"));
    }
  }
  async decide(input: {
    operationId: string;
    decisionId: string;
    binding: string;
    resolutionKey: string;
    status: "accepted" | "rejected" | "revise";
    feedback?: string;
  }): Promise<ApplicationOperation> {
    return this.notify(
      await this.repository.resolveDecision(
        input.operationId,
        input.decisionId,
        input.binding,
        input.resolutionKey,
        input.status,
        input.feedback,
        this.now(),
      ),
    );
  }
  async resolveUnknown(
    input: Parameters<ApplicationOperationRepository["resolveUnknown"]>[0],
  ): Promise<ApplicationOperation> {
    return this.notify(await this.repository.resolveUnknown(input, this.now()));
  }
  projection(operation: ApplicationOperation) {
    return projectApplicationOperation(operation, this.now());
  }

  async assertToolDispatch(
    taskId: string,
    readOnly: boolean,
    rawReference?: unknown,
  ): Promise<void> {
    if (readOnly) return;
    const reference =
      rawReference && typeof rawReference === "object"
        ? (rawReference as {
            operationId: string;
            attemptId: string;
            generation: number;
            phase: ApplicationAttempt["phase"];
          })
        : undefined;
    if (reference) {
      if (!(await this.repository.authorizesToolAttempt(taskId, reference, this.now())))
        throw new ApplicationNotDispatchedError(
          "The application tool attempt is stale or is a read-only observation",
        );
      return;
    }
    const operations = await this.repository.list(taskId, 500);
    if (
      operations.some((operation) =>
        ["submitting", "running", "unknown"].includes(operation.execution),
      )
    )
      throw new ApplicationNotDispatchedError(
        "Reconcile pending application effects before issuing another direct mutation",
      );
  }

  private outcome(
    context: ApplicationAdapterContext,
    outcome: ApplicationAdapterOutcome,
    observing: boolean,
  ): ApplicationOperationUpdate {
    if (!outcome || typeof outcome !== "object") throw new Error("Invalid application outcome");
    switch (outcome.status) {
      case "prepared": {
        if (!observing || context.operation.pendingAction !== "prepare")
          throw new Error("Unexpected preparation outcome");
        const prepared = ApplicationPreparedChangeSchema.parse(outcome.prepared);
        applicationJson(prepared, true);
        const next = { ...context.operation, prepared };
        return {
          execution: "prepared",
          prepared,
          ...(context.operation.request.decision
            ? {
                decision: {
                  id: randomUUID(),
                  operationId: context.operation.id,
                  binding: applicationDecisionBinding(next),
                  status: "pending" as const,
                  ...context.operation.request.decision,
                },
              }
            : {}),
        };
      }
      case "cancelled": {
        if (!observing) throw new Error("Cancellation outcomes require original-route observation");
        return {
          execution: "cancelled",
          cancellation: "confirmed",
          error: outcome.summary,
          ...(outcome.result ? { result: ApplicationResultSchema.parse(outcome.result) } : {}),
        };
      }
      case "completed":
        if (observing && context.operation.pendingAction === "prepare")
          throw new Error("Reconcile the preparation before reporting business completion");
        return {
          execution: "completed",
          result: ApplicationResultSchema.parse(outcome.result),
          externalId: this.externalId(outcome.externalId),
          error: undefined,
          nextPollAt: undefined,
        };
      case "running":
        return {
          execution: "running",
          externalId: this.externalId(outcome.externalId, true),
          nextPollAt:
            this.now() +
            Math.max(1_000, Math.min(60_000, outcome.pollAfterMs ?? this.options.pollMs ?? 5_000)),
          error: undefined,
        };
      case "failed":
        return {
          execution: "failed",
          error: outcome.summary,
          result: outcome.result ? ApplicationResultSchema.parse(outcome.result) : undefined,
        };
      case "unknown":
        return {
          execution: "unknown",
          error: outcome.summary,
          externalId: this.externalId(outcome.externalId) ?? context.operation.externalId,
          nextPollAt: this.now() + (this.options.pollMs ?? 5_000),
        };
      case "not_applied": {
        if (!observing)
          throw new Error(
            "Only authoritative reconciliation can make an application operation replayable",
          );
        if (
          context.operation.pendingAction === "cancel" ||
          context.operation.pendingAction === "prepare"
        )
          throw new Error(
            "A preparation or cancellation lookup cannot authorize replay of the business action",
          );
        // Only authoritative observation may establish that the original request had no effect.
        const replay = context.operation.route.replay;
        const canReplay =
          replay !== "never" &&
          context.operation.attemptCount < context.operation.request.constraints.maxAttempts;
        return {
          execution: canReplay ? "planned" : "failed",
          error: outcome.summary,
          externalId: undefined,
        };
      }
      default:
        throw new Error("Unknown application outcome status");
    }
  }
  private externalId(value: unknown, required = false): string | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 256)
      throw new Error("Invalid application job identity");
    applicationJson({ externalId: value }, true);
    return value;
  }
  private perform(
    operation: ApplicationOperation,
    phase: ApplicationAttempt["phase"],
    adapter: ApplicationAdapter,
    callback: (context: ApplicationAdapterContext) => Promise<ApplicationOperationUpdate>,
  ): Promise<ApplicationOperation> {
    const promise = this.performClaim(operation, phase, adapter, callback);
    this.inFlight.add(promise);
    void promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
    return promise;
  }
  private async performClaim(
    operation: ApplicationOperation,
    phase: ApplicationAttempt["phase"],
    adapter: ApplicationAdapter,
    callback: (context: ApplicationAdapterContext) => Promise<ApplicationOperationUpdate>,
  ): Promise<ApplicationOperation> {
    if (this.stopped)
      throw new ApplicationNotDispatchedError("Application execution service is stopped");
    const leaseMs = this.options.leaseMs ?? 30_000;
    const claim = await this.repository.claim(operation.id, phase, this.owner, this.now(), leaseMs);
    if (!claim) {
      const current = await this.get(operation.id);
      return current.revision !== operation.revision ? this.notify(current) : current;
    }
    const controller = new AbortController();
    this.active.set(operation.id, controller);
    const context: ApplicationAdapterContext = {
      operation: snapshotToolInput(claim.operation),
      attemptId: claim.attempt.id,
      idempotencyKey: operation.id,
      generation: claim.generation,
      phase,
      signal: controller.signal,
      tools: this.tools,
    };
    const timeoutMs = Math.max(
      1_000,
      Math.min(120_000, this.options.timeoutMs ?? operation.route.callTimeoutMs ?? 30_000),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let effectPhaseStarted = phase !== "execute" || !adapter.authorize;
    const startDeadline = () => {
      timeout = setTimeout(
        () =>
          controller.abort(
            new Error("Application adapter deadline exceeded; reconcile before retrying"),
          ),
        timeoutMs,
      );
      timeout.unref?.();
    };
    if (effectPhaseStarted) startDeadline();
    let renewing = false;
    const heartbeat = setInterval(
      () => {
        if (renewing || controller.signal.aborted) return;
        renewing = true;
        void this.repository
          .renew(claim, this.now(), leaseMs)
          .then((owned) => {
            if (!owned) controller.abort(new Error("Application lease ownership lost"));
          })
          .catch((error) => controller.abort(error))
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(250, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref?.();
    let abortListener: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () =>
        reject(controller.signal.reason ?? new Error("Application execution interrupted"));
      controller.signal.addEventListener("abort", abortListener, { once: true });
    });
    try {
      const action = async () => {
        const readiness = await adapter.readiness(context);
        if (!readiness.ready)
          throw new ApplicationNotDispatchedError(
            readiness.reason || "Application adapter is not ready",
          );
        controller.signal.throwIfAborted();
        if (phase === "execute" && adapter.authorize) {
          await adapter.authorize(context);
          controller.signal.throwIfAborted();
          effectPhaseStarted = true;
          startDeadline();
        }
        return callback(context);
      };
      const update = await Promise.race([action(), aborted]);
      const next = await this.repository.finish(claim, update, this.now());
      return this.notify(next ?? (await this.get(operation.id)));
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      const safeFailure = error instanceof ApplicationNotDispatchedError || !effectPhaseStarted;
      const current = await this.get(operation.id);
      const update: ApplicationOperationUpdate =
        phase === "verify"
          ? {
              execution: "completed",
              verification: "unavailable",
              verificationResult: {
                status: "unavailable",
                summary,
                checkedAt: this.now(),
                evidence: [],
              },
            }
          : {
              execution:
                safeFailure && ["prepare", "execute"].includes(phase)
                  ? "failed"
                  : current.execution === "completed"
                    ? "completed"
                    : "unknown",
              error: summary,
              notDispatched: phase === "execute" && safeFailure,
              nextPollAt: this.now() + (this.options.pollMs ?? 5_000),
            };
      const next = await this.repository.finish(claim, update, this.now());
      return this.notify(next ?? (await this.get(operation.id)));
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      this.active.delete(operation.id);
    }
  }
  async runWorkerOnce(): Promise<void> {
    if (this.workerRun) return this.workerRun;
    this.workerRun = this.recover().finally(() => {
      this.workerRun = undefined;
    });
    return this.workerRun;
  }
  private async recover(): Promise<void> {
    if (this.stopped) return;
    const expired = await this.repository.recoverExpired(this.now());
    for (const operation of await this.repository.recoverable(this.now())) {
      if (expired > 0) this.notify(operation);
      if (
        this.stopped ||
        this.active.has(operation.id) ||
        (operation.nextPollAt && operation.nextPollAt > this.now())
      )
        continue;
      try {
        if (operation.cancellation === "requested" && operation.pendingAction !== "cancel")
          await this.cancel(operation.id);
        else if (["planned", "prepared"].includes(operation.execution))
          await this.execute(operation.id);
        else if (operation.execution === "completed") await this.verify(operation.id);
        else await this.reconcile(operation.id);
      } catch (error) {
        this.hooks.warning?.(error);
      }
    }
  }
  start(): void {
    if (this.timer || this.stopped) return;
    const tick = () => {
      this.timer = undefined;
      void this.runWorkerOnce()
        .catch((error) => this.hooks.warning?.(error))
        .finally(() => {
          if (!this.stopped) {
            this.timer = setTimeout(tick, this.options.pollMs ?? 5_000);
            this.timer.unref?.();
          }
        });
    };
    this.timer = setTimeout(tick, 0);
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values())
      controller.abort(new Error("Application worker stopped; recover on restart"));
    await Promise.allSettled([...this.inFlight, ...(this.workerRun ? [this.workerRun] : [])]);
  }
}
