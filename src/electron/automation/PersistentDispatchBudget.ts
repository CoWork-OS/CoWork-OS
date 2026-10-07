import type { SchedulerFence } from "./scheduler-lease-store";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { serviceStatements } from "../database/service-statements";
import {
  DEFAULT_ENTITY_DISPATCH_COOLDOWN_MS,
  DEFAULT_WORKSPACE_DISPATCHES_PER_DAY,
  normalizeDispatchEntityKey,
  type BackgroundDispatchRequest,
  type BackgroundDispatchBudgetAuthority,
} from "../agents/BackgroundDispatchBudget";

export class PersistentDispatchBudget implements BackgroundDispatchBudgetAuthority {
  constructor(
    private db: Database.Database,
    private options: {
      maxPerWorkspacePerDay?: number;
      entityCooldownMs?: number;
      now?: () => number;
      getSchedulerFence?: () => SchedulerFence;
    } = {},
  ) {}
  private params(withFence = false) {
    const now = this.options.now?.() ?? Date.now();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return {
      now,
      ...(withFence && this.options.getSchedulerFence
        ? { schedulerFence: this.options.getSchedulerFence() }
        : {}),
      dayStart: start.getTime(),
      maxPerDay: this.options.maxPerWorkspacePerDay ?? DEFAULT_WORKSPACE_DISPATCHES_PER_DAY,
      cooldownMs: this.options.entityCooldownMs ?? DEFAULT_ENTITY_DISPATCH_COOLDOWN_MS,
    };
  }
  private request(request: BackgroundDispatchRequest) {
    if (!request.workspaceId?.trim()) throw new Error("Dispatch workspace is required");
    if (
      request.occurrenceKey !== undefined &&
      (!request.occurrenceKey.trim() || request.occurrenceKey.length > 512)
    )
      throw new Error("Invalid dispatch occurrence key");
    return { ...request, entityKey: normalizeDispatchEntityKey(request.entityKey) };
  }
  check(request: BackgroundDispatchRequest) {
    return serviceStatements(this.db).unit("dispatchBudget_check", [
      this.request(request),
      this.params(true),
    ]);
  }
  tryConsume(request: BackgroundDispatchRequest) {
    return serviceStatements(this.db).unit("dispatchBudget_reserve", [
      this.request(request),
      this.params(true),
      randomUUID(),
    ]);
  }
  async refund(ticket?: string): Promise<void> {
    if (ticket)
      await serviceStatements(this.db).unit("dispatchBudget_refund", [ticket, this.params().now]);
  }
  snapshot(workspaceId: string) {
    return serviceStatements(this.db).unit("dispatchBudget_snapshot", [workspaceId, this.params()]);
  }
}
