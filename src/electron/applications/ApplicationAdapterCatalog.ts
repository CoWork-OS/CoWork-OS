import type {
  ApplicationOperation,
  ApplicationOperationRequest,
  ApplicationPreparedChange,
  ApplicationResource,
  ApplicationResult,
  ApplicationRoute,
  ApplicationVerification,
} from "../../shared/application-execution";
import { ApplicationRouteSchema } from "../../shared/application-execution";
import { snapshotToolInput } from "../agent/tools/tool-input-snapshot";

export interface ApplicationAdapterContext {
  operation: ApplicationOperation;
  attemptId: string;
  /** Logical identity is stable across transport attempts and runtimes. */
  idempotencyKey: string;
  generation: number;
  phase: "prepare" | "execute" | "observe" | "verify" | "cancel";
  signal: AbortSignal;
  /** Every effectful tool, including prepare/cancel, must use the host's existing policy gateway. */
  tools: ApplicationToolGateway;
}
export interface ApplicationToolGateway {
  call(
    name: string,
    input: Record<string, unknown>,
    context: ApplicationAdapterContext,
  ): Promise<unknown>;
}
export type ApplicationAdapterOutcome =
  | { status: "prepared"; prepared: ApplicationPreparedChange }
  | { status: "cancelled"; summary: string; result?: ApplicationResult }
  | { status: "running"; externalId: string; pollAfterMs?: number }
  | { status: "completed"; result: ApplicationResult; externalId?: string }
  | { status: "failed"; summary: string; result?: ApplicationResult }
  | { status: "unknown"; summary: string; externalId?: string }
  | { status: "not_applied"; summary: string };
export interface ApplicationAdapter {
  route: ApplicationRoute;
  /** Host registration is trusted code. Model input cannot declare replay/verification semantics. */
  validateInput(input: Record<string, unknown>, resources: ApplicationResource[]): void;
  readiness(context: ApplicationAdapterContext): Promise<{ ready: boolean; reason?: string }>;
  prepare?(context: ApplicationAdapterContext): Promise<ApplicationPreparedChange>;
  /** Trusted approval-only hook. Must not dispatch application input or external effects.
   * Runs before the execute deadline; abort here is definitively not dispatched. */
  authorize?(context: ApplicationAdapterContext): Promise<void>;
  execute(context: ApplicationAdapterContext): Promise<ApplicationAdapterOutcome>;
  observe?(context: ApplicationAdapterContext): Promise<ApplicationAdapterOutcome>;
  cancel?(context: ApplicationAdapterContext): Promise<{ confirmed: boolean; summary: string }>;
  verify?(context: ApplicationAdapterContext): Promise<ApplicationVerification>;
}

export class ApplicationNotDispatchedError extends Error {}

export class ApplicationAdapterCatalog {
  private readonly adapters = new Map<string, ApplicationAdapter>();
  register(adapter: ApplicationAdapter): void {
    const route = snapshotToolInput(ApplicationRouteSchema.parse(adapter.route));
    if (this.adapters.has(route.id))
      throw new Error(`Application route already registered: ${route.id}`);
    if (route.replay === "read_only" && route.effect !== "read")
      throw new Error("Read replay requires a read-only operation");
    for (const method of ["prepare", "observe", "cancel", "verify"] as const)
      if (route.supports[method] !== (typeof adapter[method] === "function"))
        throw new Error(`Invalid adapter support declaration: ${method}`);
    this.adapters.set(route.id, {
      route,
      validateInput: adapter.validateInput.bind(adapter),
      readiness: adapter.readiness.bind(adapter),
      execute: adapter.execute.bind(adapter),
      ...(adapter.prepare ? { prepare: adapter.prepare.bind(adapter) } : {}),
      ...(adapter.authorize ? { authorize: adapter.authorize.bind(adapter) } : {}),
      ...(adapter.observe ? { observe: adapter.observe.bind(adapter) } : {}),
      ...(adapter.cancel ? { cancel: adapter.cancel.bind(adapter) } : {}),
      ...(adapter.verify ? { verify: adapter.verify.bind(adapter) } : {}),
    });
  }
  remove(id: string): void {
    this.adapters.delete(id);
  }
  list(capability?: string): ApplicationRoute[] {
    return [...this.adapters.values()]
      .filter((a) => !capability || a.route.capability === capability)
      .map((a) => structuredClone(a.route));
  }
  resolve(request: ApplicationOperationRequest): ApplicationAdapter {
    const candidates = [...this.adapters.values()].filter(
      ({ route }) =>
        route.capability === request.capability &&
        (!request.routeId || request.routeId === route.id) &&
        (!request.constraints.localOnly || route.environment.locality === "local") &&
        (!request.constraints.backgroundRequired || route.environment.background) &&
        request.resources.every((resource) => route.resourceKinds.includes(resource.kind)),
    );
    // There is no arbitrary MCP/API/GUI priority. Ambiguous routes require explicit selection.
    if (candidates.length !== 1)
      throw new Error(
        candidates.length
          ? "Select an explicit eligible application route"
          : "No eligible application route",
      );
    const adapter = candidates[0];
    adapter.validateInput(snapshotToolInput(request.input), snapshotToolInput(request.resources));
    return adapter;
  }
  forOperation(operation: ApplicationOperation): ApplicationAdapter {
    const adapter = this.adapters.get(operation.route.id);
    if (!adapter || JSON.stringify(adapter.route) !== JSON.stringify(operation.route))
      throw new ApplicationNotDispatchedError(
        "The original application adapter/version/environment is unavailable",
      );
    adapter.validateInput(
      snapshotToolInput(operation.request.input),
      snapshotToolInput(operation.request.resources),
    );
    return adapter;
  }
}

/** Runtime drivers may plan through this port; business operation state stays in CoWork. */
export interface ApplicationRuntimeDriver {
  id: string;
  version: string;
  capabilities: {
    resume: boolean;
    interrupt: boolean;
    controlledTools: boolean;
  };
  start(request: {
    sessionId: string;
    prompt: string;
    tools: ApplicationToolGateway;
  }): Promise<{ runtimeSessionId: string }>;
  continue(runtimeSessionId: string, input: string): Promise<void>;
  resume(runtimeSessionId: string): Promise<void>;
  interrupt(runtimeSessionId: string): Promise<void>;
}
