/**
 * Declared per-tool costs for MCP servers that spend a vendor's credits, and the per-task
 * tally behind a spend limit. The approval card names a costed call's estimate and what the
 * task has used so far; a call that would take the task past the limit asks again even
 * when its tool is otherwise allowed to run without a prompt.
 *
 * Figures are the vendor's published estimates. The tally counts the top of each range for
 * every call that was dispatched, never the vendor's bill. Tools without a declared cost
 * (or with zero cost) never reach any of this.
 */

export interface ToolCost {
  low: number;
  high: number;
  /** Shown after the range, e.g. "3 per action". */
  note?: string;
  /** For a price per item: the input array field that lists the items (one item when absent). */
  perItemField?: string;
}

export interface ToolCostPolicy {
  /** Display name of the vendor in sentences ("Meshy"). */
  vendor: string;
  /** Keyed by the server's own tool name. */
  costs: Readonly<Record<string, ToolCost>>;
  /** Per-task limit in `unit`; 0 turns the limit off. */
  limit: number;
  unit: string;
  /**
   * Tools known to spend nothing. A tool neither here nor in `costs` (a new paid tool in a
   * later server version) has an unknown cost and always asks.
   */
  freeTools?: ReadonlySet<string>;
}

export interface PendingCharge {
  /** Tally key: one per task and server. */
  key: string;
  tool: string;
  cost: ToolCost;
  policy: ToolCostPolicy;
  /** The tool's cost is not declared: the call always asks. */
  unknown: boolean;
}

// In memory only. A forgotten total would hand a task that already spent its limit a fresh
// budget, so entries are not evicted; each is one number per task that used a costed server.
const spentByTask = new Map<string, number>();

export function pendingCharge(
  policy: ToolCostPolicy | null | undefined,
  taskId: string,
  serverId: string,
  serverToolName: string,
  input?: unknown,
): PendingCharge | null {
  if (!policy) return null;
  const key = `${taskId}\u0000${serverId}`;
  const declared = policy.costs[serverToolName];
  if (!declared) {
    if (policy.freeTools?.has(serverToolName)) return null;
    return { key, tool: serverToolName, cost: { low: 0, high: 0 }, policy, unknown: true };
  }
  if (declared.high <= 0) return null;
  let cost = declared;
  if (declared.perItemField && input && typeof input === "object") {
    const items = (input as Record<string, unknown>)[declared.perItemField];
    const count = Array.isArray(items) ? Math.max(1, items.length) : 1;
    cost = { ...declared, low: declared.low * count, high: declared.high * count };
  }
  return { key, tool: serverToolName, cost, policy, unknown: false };
}

export function chargeSpent(charge: PendingCharge): number {
  return spentByTask.get(charge.key) ?? 0;
}

/** True when the call must ask even if its tool may otherwise run without a prompt. */
export function chargeExceedsLimit(charge: PendingCharge, spent = chargeSpent(charge)): boolean {
  if (charge.unknown) return true;
  return charge.policy.limit > 0 && spent + charge.cost.high > charge.policy.limit;
}

/**
 * Counts the call against the task's tally. Booked when the call is admitted, in the same
 * synchronous step as the limit check, so parallel calls cannot all pass on one total.
 */
export function bookCharge(charge: PendingCharge): void {
  spentByTask.set(charge.key, chargeSpent(charge) + charge.cost.high);
}

/** Gives back a booking for a call that was refused before it ran. */
export function refundCharge(charge: PendingCharge): void {
  spentByTask.set(charge.key, Math.max(0, chargeSpent(charge) - charge.cost.high));
}

function formatAmount(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(1);
}

function quantity(amount: number, unit: string): string {
  const singular = amount === 1 && unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${formatAmount(amount)} ${singular}`;
}

export function costSentence(charge: PendingCharge): string {
  const { cost, policy } = charge;
  if (charge.unknown) {
    return `${policy.vendor} does not list a price for ${charge.tool}; it may spend ${policy.unit}.`;
  }
  const range =
    cost.low === cost.high
      ? `Costs about ${quantity(cost.high, policy.unit)}`
      : `Costs ${formatAmount(cost.low)}–${quantity(cost.high, policy.unit)}`;
  return cost.note ? `${range} (${cost.note}).` : `${range}.`;
}

export function spendSentence(charge: PendingCharge, spent = chargeSpent(charge)): string {
  const { policy } = charge;
  if (spent > 0) {
    const cap = policy.limit > 0 ? ` (limit ${formatAmount(policy.limit)})` : "";
    return `This task has used about ${quantity(spent, policy.unit)} on ${policy.vendor}${cap}.`;
  }
  return policy.limit > 0
    ? `Spend limit for this task on ${policy.vendor}: ${quantity(policy.limit, policy.unit)}.`
    : "";
}

/** The lines an approval card shows for a costed call. */
export function chargeLines(charge: PendingCharge, spent = chargeSpent(charge)): string[] {
  const lines = [costSentence(charge), spendSentence(charge, spent)];
  if (!charge.unknown && chargeExceedsLimit(charge, spent)) {
    lines.push(
      `This call would take the task past its ${quantity(charge.policy.limit, charge.policy.unit)} limit, so it needs your approval.`,
    );
  }
  return lines.filter(Boolean);
}

/** Test hook. */
export function resetToolCostTallyForTests(): void {
  spentByTask.clear();
}
