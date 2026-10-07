import type { SchedulerOwnershipAuthority } from "./SchedulerOwnership";
import type { SchedulerFence, SchedulerLease } from "./scheduler-lease-store";
/** Shared lifecycle authority for desktop and Node automation services. */
export type AutomationProducer =
  | "cron"
  | "heartbeat"
  | "event_triggers"
  | "routines"
  | "strategic_planner";
export type AutomationRuntimeKind = "desktop" | "electron_headless" | "node";
export type AutomationRuntimeState =
  | "not_started"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "waiting_for_owner";
export interface AutomationService {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}
interface Entry {
  service?: AutomationService;
  state: AutomationRuntimeState;
  reason?: string;
  operation: Promise<void>;
  requested: boolean;
  generation: number;
  cleanupFailed?: boolean;
}
const PRODUCERS: AutomationProducer[] = [
  "cron",
  "heartbeat",
  "event_triggers",
  "routines",
  "strategic_planner",
];
export class AutomationRuntime {
  private readonly entries = new Map<AutomationProducer, Entry>();
  private recovery?: AutomationService;
  private recoveryStarted = false;
  private recoveryOperation: Promise<void> = Promise.resolve();
  private recoveryCleanupFailed = false;
  registerRecovery(service: AutomationService): void {
    if (this.closed || this.recovery || [...this.entries.values()].some((entry) => entry.requested))
      throw new Error("Recovery must be registered before automation starts");
    this.recovery = service;
  }
  private startRecovery(): Promise<void> {
    const operation = this.recoveryOperation
      .catch(() => {})
      .then(async () => {
        if (this.closed || !this.recovery || this.recoveryStarted) return;
        if (this.recoveryCleanupFailed)
          throw new Error("Recovery cleanup must finish before dispatch");
        try {
          await this.recovery.start();
          this.recoveryStarted = true;
        } catch (error) {
          try {
            await this.recovery.stop();
          } catch {
            this.recoveryCleanupFailed = true;
          }
          throw error;
        }
      });
    this.recoveryOperation = operation;
    return operation;
  }
  private stopRecovery(): Promise<void> {
    const operation = this.recoveryOperation
      .catch(() => {})
      .then(async () => {
        if (!this.recovery) return;
        try {
          await this.recovery.stop();
          this.recoveryStarted = false;
          this.recoveryCleanupFailed = false;
        } catch (error) {
          this.recoveryCleanupFailed = true;
          throw error;
        }
      });
    this.recoveryOperation = operation;
    return operation;
  }
  private closed = false;
  private ownership?: SchedulerOwnershipAuthority;
  private lease: SchedulerLease | null = null;
  private ownershipOperation: Promise<unknown> = Promise.resolve();
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing: Promise<void> | null = null;
  constructor(readonly kind: AutomationRuntimeKind) {
    for (const id of PRODUCERS)
      this.entries.set(id, {
        state: "not_started",
        reason: "Service has not been initialized",
        operation: Promise.resolve(),
        requested: false,
        generation: 0,
      });
  }
  register(id: AutomationProducer, service: AutomationService, reason?: string): void {
    if (this.closed) throw new Error("Automation runtime is shutting down");
    const entry = this.entry(id);
    if (entry.service && entry.service !== service)
      throw new Error(`Automation service already registered: ${id}`);
    entry.service = service;
    entry.reason = reason;
  }
  start(id: AutomationProducer): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Automation runtime is shutting down"));
    const entry = this.entry(id);
    if (!entry.service)
      return Promise.reject(new Error(`Automation service is not initialized: ${id}`));
    if (entry.cleanupFailed)
      return Promise.reject(new Error("Automation service cleanup must finish before restart"));
    if (entry.requested) return entry.operation;
    entry.requested = true;
    const generation = ++entry.generation;
    return this.enqueue(entry, async () => {
      // A shutdown request while queued prevents this startup entirely.
      if (!entry.requested || this.closed || entry.generation !== generation) return;
      if (!(await this.acquireOwnership())) {
        entry.state = "waiting_for_owner";
        entry.reason = "Another process owns this profile's scheduler";
        return;
      }
      if (!entry.requested || this.closed || entry.generation !== generation) return;
      entry.state = "starting";
      entry.reason = undefined;
      try {
        await this.startRecovery();
        if (!entry.requested || this.closed || entry.generation !== generation) return;
        await entry.service!.start();
        entry.state = "running";
      } catch (error) {
        // A partially started service must release its timers before a retry.
        try {
          await entry.service!.stop();
        } catch {
          entry.cleanupFailed = true;
        }
        entry.requested = false;
        entry.state = "failed";
        entry.reason = "Service startup failed";
        throw error;
      }
    });
  }
  stop(id: AutomationProducer): Promise<void> {
    const entry = this.entry(id);
    entry.requested = false;
    ++entry.generation;
    return this.enqueue(entry, async () => {
      if (!entry.service || entry.state === "stopped") return;
      entry.state = "stopping";
      try {
        await entry.service.stop();
        entry.cleanupFailed = false;
        entry.state = "stopped";
        entry.reason = undefined;
      } catch (error) {
        entry.state = "failed";
        entry.cleanupFailed = true;
        entry.reason = "Service shutdown failed";
        throw error;
      }
    });
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.renewalTimer) clearInterval(this.renewalTimer);
    this.renewalTimer = null;
    const failures: unknown[] = [];
    try {
      await this.refreshing;
    } catch (error) {
      failures.push(error);
    }
    // Disallow queued startups before waiting for any service's cleanup.
    for (const entry of this.entries.values()) entry.requested = false;
    for (const id of [...PRODUCERS].reverse()) {
      try {
        await this.stop(id);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await this.stopRecovery();
    } catch (error) {
      failures.push(error);
    }
    if (!failures.length && this.lease && this.ownership) await this.ownership.release(this.lease);
    this.lease = null;
    if (failures.length) throw new AggregateError(failures, "Automation shutdown failed");
  }
  snapshot() {
    return {
      runtime: this.kind,
      scheduler: !this.ownership
        ? "uncoordinated"
        : this.lease && this.lease.expiresAt > Date.now()
          ? "owned"
          : "waiting_for_owner",
      producers: PRODUCERS.map((id) => {
        const entry = this.entry(id);
        return { id, state: entry.state, ...(entry.reason ? { reason: entry.reason } : {}) };
      }),
      capabilities: {
        localTasks: "supported" as const,
        desktopInteraction:
          this.kind !== "desktop" ? ("waiting_for_desktop" as const) : ("supported" as const),
      },
    };
  }
  attachOwnership(authority: SchedulerOwnershipAuthority): void {
    if (this.ownership || [...this.entries.values()].some((entry) => entry.requested))
      throw new Error("Scheduler ownership must be attached before services start");
    this.ownership = authority;
  }
  captureFence(): SchedulerFence {
    if (
      this.recoveryCleanupFailed ||
      [...this.entries.values()].some((entry) => entry.cleanupFailed)
    )
      throw new Error("Automation service cleanup must finish before dispatch");
    if (this.closed || !this.lease || this.lease.expiresAt <= Date.now())
      throw new Error("Waiting for automation scheduler ownership");
    return { owner: this.lease.owner, generation: this.lease.generation };
  }
  async assertOwnership(): Promise<void> {
    const fence = this.captureFence();
    if (!this.ownership || !(await this.ownership.validate(fence))) {
      this.lease = null;
      throw new Error("Automation scheduler ownership expired or changed");
    }
  }
  private acquireOwnership(): Promise<boolean> {
    if (!this.ownership) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    if (!this.renewalTimer) {
      this.renewalTimer = setInterval(() => {
        void this.refreshOwnership().catch(() => {});
      }, 15000);
      this.renewalTimer.unref?.();
    }
    const operation = this.ownershipOperation
      .catch(() => {})
      .then(async () => {
        if (this.closed) return false;
        try {
          this.lease = await this.ownership!.acquire();
        } catch {
          this.lease = null;
        }
        return this.lease !== null;
      });
    this.ownershipOperation = operation;
    return operation;
  }
  /** Renew or take over an expired lease, stopping old service generations first. */
  refreshOwnership(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const refreshing = this.refreshOwnershipNow().finally(() => {
      this.refreshing = null;
    });
    this.refreshing = refreshing;
    return refreshing;
  }
  private async refreshOwnershipNow(): Promise<void> {
    if (this.closed || !this.ownership) return;
    const previous = this.lease;
    const owned = await this.acquireOwnership();
    const changed = previous && (!this.lease || previous.generation !== this.lease.generation);
    const failures: unknown[] = [];
    if (!owned || changed) {
      try {
        await this.stopRecovery();
      } catch (error) {
        failures.push(error);
      }
      for (const entry of this.entries.values()) {
        if (!entry.service || !["running", "starting"].includes(entry.state)) continue;
        ++entry.generation;
        await this.enqueue(entry, async () => {
          entry.state = "stopping";
          try {
            await entry.service!.stop();
            entry.state = entry.requested ? "waiting_for_owner" : "stopped";
          } catch (error) {
            entry.cleanupFailed = true;
            entry.state = "failed";
            entry.reason = "Service shutdown failed";
            throw error;
          }
        }).catch((error) => {
          failures.push(error);
        });
      }
    }
    if (failures.length) throw new AggregateError(failures, "Automation ownership cleanup failed");
    if (owned && !this.closed) {
      await this.startRecovery();
      for (const [id, entry] of this.entries) {
        if (!entry.requested || !["waiting_for_owner", "failed"].includes(entry.state)) continue;
        entry.requested = false;
        await this.start(id);
      }
    }
  }
  private entry(id: AutomationProducer): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown automation producer");
    return entry;
  }
  private enqueue(entry: Entry, action: () => Promise<void>): Promise<void> {
    const operation = entry.operation.catch(() => {}).then(action);
    entry.operation = operation;
    return operation;
  }
}
let currentRuntime: AutomationRuntime | null = null;
export function setAutomationRuntime(runtime: AutomationRuntime | null): void {
  currentRuntime = runtime;
}
export function getAutomationRuntime(): AutomationRuntime | null {
  return currentRuntime;
}
