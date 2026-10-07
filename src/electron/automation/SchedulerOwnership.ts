import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { serviceStatements } from "../database/service-statements";
import type { SchedulerFence, SchedulerLease } from "./scheduler-lease-store";
export interface SchedulerOwnershipAuthority {
  acquire(): Promise<SchedulerLease | null>;
  validate(fence: SchedulerFence): Promise<boolean>;
  release(fence: SchedulerFence): Promise<void>;
}
export class SchedulerOwnership implements SchedulerOwnershipAuthority {
  private readonly sql;
  private readonly owner = randomUUID();
  constructor(
    db: Database.Database,
    private readonly options: { now?: () => number; leaseMs?: number } = {},
  ) {
    this.sql = serviceStatements(db);
  }
  acquire(): Promise<SchedulerLease | null> {
    return this.sql.unit("schedulerLease_acquire", [
      {
        owner: this.owner,
        now: (this.options.now ?? Date.now)(),
        leaseMs: this.options.leaseMs ?? 60000,
      },
    ]);
  }
  validate(fence: SchedulerFence): Promise<boolean> {
    return this.sql.unit("schedulerLease_validate", [fence, (this.options.now ?? Date.now)()]);
  }
  async release(fence: SchedulerFence): Promise<void> {
    await this.sql.unit("schedulerLease_release", [fence]);
  }
}
