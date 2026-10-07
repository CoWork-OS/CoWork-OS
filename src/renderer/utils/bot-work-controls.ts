import {
  defaultWorkControlStorage,
  readWorkControlCache,
  writeWorkControlCache,
  type WorkControlStorage,
} from "./bot-work-control-cache";
import { requiresWorkCleanup } from "../../shared/bot-work-control";
import type {
  BotFutureControlState,
  BotWorkControlRead,
  BotWorkControlRequest,
  BotWorkControlReceipt,
} from "../../shared/bot-work-control";
type Scope = BotWorkControlRead["scope"];
export interface BotWorkControlState {
  request: BotWorkControlRequest | null;
  receipt: BotWorkControlReceipt | null;
  stopped: Array<{ taskId: string; stopVersion: number }>;
  busy: boolean;
  error: string | null;
  recoveryWarning: string | null;
  future: BotFutureControlState | null;
  futureError: string | null;
}
export function controlNeedsReconciliation(
  state: Pick<BotWorkControlState, "request" | "receipt" | "future">,
): boolean {
  if (!state.request) return false;
  if (
    !state.receipt &&
    state.request.action === "resume_bot" &&
    state.future &&
    state.future.futureControlVersion > state.request.expectedFutureControlVersion!
  )
    return false;
  return (
    !state.receipt ||
    state.receipt.status === "pending" ||
    (requiresWorkCleanup(state.receipt.action) && state.receipt.stillActiveTaskIds.length > 0)
  );
}
const owners = new Map<string, symbol>();
const sessions = new Map<string, BotWorkControlState>();
/** Keeps an ambiguous request identity across dialog reopen; suppresses late scoped replies. */
export class BotWorkControls {
  private disposed = false;
  private owner = Symbol();
  private generation = 0;
  private futureGeneration = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private state: BotWorkControlState;
  private key: string;
  constructor(
    private api: {
      stopBotWork(input: BotWorkControlRequest): Promise<BotWorkControlReceipt | null>;
      getBotWorkControl(input: BotWorkControlRead): Promise<BotWorkControlReceipt | null>;
      getBotFutureControl?(input: { scope: Scope }): Promise<BotFutureControlState>;
    },
    private scope: Scope,
    private changed: () => void,
    private delay = 2000,
    private storage: WorkControlStorage | null | undefined = defaultWorkControlStorage(),
  ) {
    this.key = JSON.stringify([scope.workspaceId, scope.agentRoleId]);
    owners.set(this.key, this.owner);
    const persisted = readWorkControlCache(scope, storage);
    const saved =
      sessions.get(this.key) ??
      (persisted
        ? {
            request: persisted.request,
            receipt: null,
            stopped: persisted.stopped,
            busy: false,
            error: null,
            recoveryWarning: null,
            future: null,
            futureError: null,
          }
        : null);
    this.state = saved
      ? { ...saved, busy: false }
      : {
          request: null,
          receipt: null,
          stopped: [],
          busy: false,
          error: null,
          recoveryWarning: null,
          future: null,
          futureError: null,
        };
  }
  activate() {
    this.disposed = false;
    owners.set(this.key, this.owner);
    void this.refreshFuture();
    if (this.state.request && controlNeedsReconciliation(this.state)) void this.check();
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(next: BotWorkControlState) {
    // Preserve an in-flight request after close, but never publish to an unmounted view.
    if (owners.get(this.key) !== this.owner) return;
    if (next.request) {
      try {
        writeWorkControlCache(next.request, next.stopped, this.storage);
      } catch {
        next = {
          ...next,
          recoveryWarning:
            next.recoveryWarning ??
            "Could not save the latest recovery state. Check cleanup before closing the app.",
        };
      }
    }
    sessions.set(this.key, next);
    if (this.disposed) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private accept(receipt: BotWorkControlReceipt | null, request: BotWorkControlRequest) {
    if (
      receipt &&
      (receipt.scope.workspaceId !== this.scope.workspaceId ||
        receipt.scope.agentRoleId !== this.scope.agentRoleId ||
        receipt.requestId !== request.requestId ||
        receipt.action !== request.action)
    )
      throw new Error("Control response belongs to another request, bot or workspace.");
    if (
      receipt?.futureControl &&
      (receipt.futureControl.scope.workspaceId !== this.scope.workspaceId ||
        receipt.futureControl.scope.agentRoleId !== this.scope.agentRoleId)
    )
      throw new Error("Future control belongs to another bot or workspace.");
    const stopped = new Map(this.state.stopped.map((item) => [item.taskId, item]));
    for (const item of receipt?.tasks ?? []) {
      if (item.status === "stopped")
        stopped.set(item.taskId, { taskId: item.taskId, stopVersion: item.stopVersion });
      if (item.status === "released") stopped.delete(item.taskId);
    }
    this.publish({
      ...this.state,
      request,
      receipt,
      future:
        receipt?.futureControl &&
        (!this.state.future ||
          receipt.futureControl.futureControlVersion >= this.state.future.futureControlVersion)
          ? receipt.futureControl
          : this.state.future,
      stopped: [...stopped.values()],
      recoveryWarning: null,
      busy: false,
      error: receipt ? null : "No cleanup receipt yet. Retry the saved request.",
    });
    if (this.disposed) return;
    if (receipt) {
      this.changed();
      void this.refreshFuture();
    }
    if (
      receipt &&
      (receipt.status === "pending" ||
        (requiresWorkCleanup(receipt.action) && receipt.stillActiveTaskIds.length))
    )
      this.schedule();
  }
  private schedule() {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.check();
    }, this.delay);
  }
  async refreshFuture() {
    if (this.disposed || !this.api.getBotFutureControl) return;
    const generation = ++this.futureGeneration;
    try {
      const future = await this.api.getBotFutureControl({ scope: this.scope });
      if (this.disposed || generation !== this.futureGeneration) return;
      if (
        future.scope.workspaceId !== this.scope.workspaceId ||
        future.scope.agentRoleId !== this.scope.agentRoleId
      )
        throw new Error("Future control belongs to another bot or workspace.");
      if (this.state.future && future.futureControlVersion < this.state.future.futureControlVersion)
        return;
      this.publish({ ...this.state, future, futureError: null });
    } catch (cause) {
      if (!this.disposed && generation === this.futureGeneration)
        this.publish({
          ...this.state,
          futureError: cause instanceof Error ? cause.message : "Could not load future control.",
        });
    }
  }
  async check() {
    if (this.disposed || !this.state.request || this.state.busy) return;
    const request = this.state.request;
    const generation = ++this.generation;
    try {
      const receipt = await this.api.getBotWorkControl({
        scope: this.scope,
        requestId: request.requestId,
      });
      if (generation === this.generation) this.accept(receipt, request);
    } catch (cause) {
      if (generation !== this.generation) return;
      this.publish({
        ...this.state,
        busy: false,
        error: cause instanceof Error ? cause.message : "Could not check cleanup.",
      });
    }
  }
  async start(
    action: BotWorkControlRequest["action"],
    taskId?: string,
    expectedStopVersion?: number,
    expectedFutureControlVersion?: number,
  ) {
    if (this.disposed || this.state.busy) return;
    if (this.state.request && controlNeedsReconciliation(this.state)) return;
    const request: BotWorkControlRequest = {
      scope: this.scope,
      requestId: crypto.randomUUID(),
      action,
      ...(taskId ? { taskId } : {}),
      ...(expectedStopVersion ? { expectedStopVersion } : {}),
      ...(expectedFutureControlVersion !== undefined ? { expectedFutureControlVersion } : {}),
    };
    await this.submit(request);
  }
  async retry() {
    if (!this.disposed && !this.state.busy && this.state.request)
      await this.submit(this.state.request);
  }
  private async submit(request: BotWorkControlRequest) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const generation = ++this.generation;
    // Fail before the API call if the new identity cannot survive a renderer restart.
    try {
      writeWorkControlCache(request, this.state.stopped, this.storage);
    } catch {
      this.publish({
        ...this.state,
        busy: false,
        error: null,
        recoveryWarning: "Stop control was not sent: could not save its recovery identity.",
      });
      return;
    }
    this.publish({
      ...this.state,
      request,
      receipt: null,
      busy: true,
      error: null,
      recoveryWarning: null,
    });
    try {
      const receipt = await this.api.stopBotWork(request);
      if (generation === this.generation) this.accept(receipt, request);
    } catch (cause) {
      if (generation !== this.generation) return;
      this.publish({
        ...this.state,
        request,
        receipt: null,
        busy: false,
        error: cause instanceof Error ? cause.message : "Could not request a control.",
      });
      void this.refreshFuture();
    }
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }
}
