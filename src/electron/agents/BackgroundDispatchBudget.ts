/**
 * BackgroundDispatchBudget — the one budget/cooldown authority for background task creation.
 *
 * Heartbeat dispatch, Workflow Intelligence auto-dispatch and the Strategic Planner's scheduled
 * runs all create tasks the user did not ask for. Each used to
 * keep its own budget, so together they could create several times the Heartbeat limit per day.
 * They now consume from one per-workspace daily budget (sized like Heartbeat's default
 * `maxDispatchesPerDay`) and share a per-entity cooldown, so two producers cannot both create a
 * task for the same open loop / target within the cooldown window.
 *
 * User-initiated work (manual pulses, "run now") is recorded but never refused.
 *
 * Production installs a database-backed authority before workers start. This in-memory
 * implementation is retained for isolated tests; per-agent limits still apply on top.
 */

export type BackgroundDispatchSource = "heartbeat" | "workflow_intelligence" | "strategic_planner";

/** Same as Heartbeat's default `maxDispatchesPerDay`. */
export const DEFAULT_WORKSPACE_DISPATCHES_PER_DAY = 6;
/** Same as Heartbeat's default dispatch cooldown (120 minutes). */
export const DEFAULT_ENTITY_DISPATCH_COOLDOWN_MS = 2 * 60 * 60 * 1000;

export interface BackgroundDispatchRequest {
  workspaceId: string;
  source: BackgroundDispatchSource;
  /** Normalized entity (open loop, WI target, issue) the task is about. */
  entityKey?: string;
  /** User-initiated: recorded against the budget but never refused. */
  manual?: boolean;
  /** Stable producer occurrence identity; replay must not create a second run. */
  occurrenceKey?: string;
}

export interface BackgroundDispatchDecision {
  allowed: boolean;
  reason?: "workspace_budget_exhausted" | "entity_cooldown" | "duplicate_occurrence";
  dispatchesToday: number;
  maxPerDay: number;
  cooldownUntil?: number;
  /** Present when the dispatch was recorded; pass it to `refund` if task creation fails. */
  ticket?: string;
  /** A durable ticket must be committed with task creation. */
  durable?: boolean;
}

export interface BackgroundDispatchBudgetAuthority {
  check(
    request: BackgroundDispatchRequest,
  ): BackgroundDispatchDecision | Promise<BackgroundDispatchDecision>;
  tryConsume(
    request: BackgroundDispatchRequest,
  ): BackgroundDispatchDecision | Promise<BackgroundDispatchDecision>;
  refund(ticket?: string): void | Promise<void>;
  snapshot(workspaceId: string):
    | {
        dispatchesToday: number;
        maxPerDay: number;
        bySource: Partial<Record<BackgroundDispatchSource, number>>;
      }
    | Promise<{
        dispatchesToday: number;
        maxPerDay: number;
        bySource: Partial<Record<BackgroundDispatchSource, number>>;
      }>;
}

interface LedgerEntry {
  ticket: string;
  workspaceId: string;
  source: BackgroundDispatchSource;
  entityKey?: string;
  at: number;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function normalizeDispatchEntityKey(value?: string): string | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized ? normalized.slice(0, 200) : undefined;
}

export class BackgroundDispatchBudget {
  private entries: LedgerEntry[] = [];
  private sequence = 0;

  constructor(
    private readonly options: {
      maxPerWorkspacePerDay?: number;
      entityCooldownMs?: number;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private get maxPerDay(): number {
    return this.options.maxPerWorkspacePerDay ?? DEFAULT_WORKSPACE_DISPATCHES_PER_DAY;
  }

  private get entityCooldownMs(): number {
    return this.options.entityCooldownMs ?? DEFAULT_ENTITY_DISPATCH_COOLDOWN_MS;
  }

  private prune(now: number): void {
    // Keep today's entries plus anything still inside an entity cooldown.
    const keepAfter = Math.min(startOfLocalDay(now), now - this.entityCooldownMs);
    if (this.entries.length > 0 && this.entries[0].at < keepAfter) {
      this.entries = this.entries.filter((entry) => entry.at >= keepAfter);
    }
  }

  /** Read-only check. */
  check(request: BackgroundDispatchRequest): BackgroundDispatchDecision {
    const now = this.now();
    this.prune(now);
    const dayStart = startOfLocalDay(now);
    const dispatchesToday = this.entries.filter(
      (entry) => entry.workspaceId === request.workspaceId && entry.at >= dayStart,
    ).length;
    const base = { dispatchesToday, maxPerDay: this.maxPerDay };
    if (request.manual) return { allowed: true, ...base };
    if (dispatchesToday >= this.maxPerDay) {
      return { allowed: false, reason: "workspace_budget_exhausted", ...base };
    }
    const entityKey = normalizeDispatchEntityKey(request.entityKey);
    if (entityKey) {
      const latest = this.entries
        .filter(
          (entry) => entry.workspaceId === request.workspaceId && entry.entityKey === entityKey,
        )
        .reduce((max, entry) => Math.max(max, entry.at), 0);
      if (latest && now - latest < this.entityCooldownMs) {
        return {
          allowed: false,
          reason: "entity_cooldown",
          cooldownUntil: latest + this.entityCooldownMs,
          ...base,
        };
      }
    }
    return { allowed: true, ...base };
  }

  /** Check and, when allowed, record the dispatch in one step. */
  tryConsume(request: BackgroundDispatchRequest): BackgroundDispatchDecision {
    const decision = this.check(request);
    if (!decision.allowed) return decision;
    const ticket = `dispatch-${++this.sequence}`;
    this.entries.push({
      ticket,
      workspaceId: request.workspaceId,
      source: request.source,
      entityKey: normalizeDispatchEntityKey(request.entityKey),
      at: this.now(),
    });
    return { ...decision, dispatchesToday: decision.dispatchesToday + 1, ticket };
  }

  /** Give back a consumed slot when the task could not be created. */
  refund(ticket?: string): void {
    if (!ticket) return;
    this.entries = this.entries.filter((entry) => entry.ticket !== ticket);
  }

  snapshot(workspaceId: string): {
    dispatchesToday: number;
    maxPerDay: number;
    bySource: Partial<Record<BackgroundDispatchSource, number>>;
  } {
    const now = this.now();
    this.prune(now);
    const dayStart = startOfLocalDay(now);
    const bySource: Partial<Record<BackgroundDispatchSource, number>> = {};
    let dispatchesToday = 0;
    for (const entry of this.entries) {
      if (entry.workspaceId !== workspaceId || entry.at < dayStart) continue;
      dispatchesToday += 1;
      bySource[entry.source] = (bySource[entry.source] || 0) + 1;
    }
    return { dispatchesToday, maxPerDay: this.maxPerDay, bySource };
  }

  reset(): void {
    this.entries = [];
  }
}

let sharedBudget: BackgroundDispatchBudgetAuthority | null = null;

export function getBackgroundDispatchBudget(): BackgroundDispatchBudgetAuthority {
  if (!sharedBudget) {
    if (process.env.NODE_ENV !== "test")
      throw new Error("The durable background dispatch authority is not initialized");
    sharedBudget = new BackgroundDispatchBudget();
  }
  return sharedBudget;
}

/** Test seam. */
export function setBackgroundDispatchBudget(
  budget: BackgroundDispatchBudgetAuthority | null,
): void {
  sharedBudget = budget;
}
