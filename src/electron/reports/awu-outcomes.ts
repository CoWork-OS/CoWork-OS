/**
 * Shared SQL for agentic work units (AWU), so the live report, the day rollups and the Usage
 * Insights panel agree on one definition.
 *
 * - Completed (any status): `status = 'completed'` with terminal `ok`, `partial_success`,
 *   `needs_user_action` or none. This is the pre-verification AWU count.
 * - Verified: terminal `ok`, and the task's latest outcome contract is not `unmet` or
 *   `partial`. When the contract is `satisfied` the unit is verified by the contract; when the
 *   task has no contract, or one with nothing the server can check, it is verified by its
 *   terminal status alone.
 * - Partial and needs-user-action units are counted on their own.
 */

/** Task rows that count as completed AWU of any status. `alias` is `""` or e.g. `"t."`. */
export function awuCompletedCondition(alias = ""): string {
  return (
    `${alias}status = 'completed' AND ` +
    `(${alias}terminal_status IN ('ok', 'partial_success', 'needs_user_action') OR ${alias}terminal_status IS NULL)`
  );
}

function latestContractStatus(alias: string): string {
  return `(SELECT oc.status FROM work_session_outcome_contracts oc WHERE oc.task_id = ${alias}id ORDER BY oc.version DESC LIMIT 1)`;
}

export type AwuOutcome =
  | "verified_contract"
  | "verified_terminal"
  | "partial"
  | "needs_user_action"
  | "other";

/**
 * One of the `AwuOutcome` values for a task row. Without an alias the row is `tasks`, which is
 * named explicitly inside the contract subquery so `id` cannot bind to the contract's own id.
 */
export function awuOutcomeExpression(alias = ""): string {
  const contract = latestContractStatus(alias || "tasks.");
  return `CASE
    WHEN ${alias}terminal_status = 'ok' AND ${contract} = 'satisfied' THEN 'verified_contract'
    WHEN ${alias}terminal_status = 'ok' AND COALESCE(${contract}, 'none') NOT IN ('unmet', 'partial') THEN 'verified_terminal'
    WHEN ${alias}terminal_status = 'partial_success' THEN 'partial'
    WHEN ${alias}terminal_status = 'needs_user_action' THEN 'needs_user_action'
    ELSE 'other'
  END`;
}

export interface AwuOutcomeCounts {
  awuCount: number;
  verifiedCount: number;
  verifiedByContractCount: number;
  partialCount: number;
  needsUserActionCount: number;
}

export function emptyAwuOutcomeCounts(): AwuOutcomeCounts {
  return {
    awuCount: 0,
    verifiedCount: 0,
    verifiedByContractCount: 0,
    partialCount: 0,
    needsUserActionCount: 0,
  };
}

/** Add one task row's outcome to the counts. */
export function addAwuOutcome(counts: AwuOutcomeCounts, outcome: unknown): void {
  counts.awuCount += 1;
  if (outcome === "verified_contract" || outcome === "verified_terminal") {
    counts.verifiedCount += 1;
    if (outcome === "verified_contract") counts.verifiedByContractCount += 1;
  } else if (outcome === "partial") {
    counts.partialCount += 1;
  } else if (outcome === "needs_user_action") {
    counts.needsUserActionCount += 1;
  }
}

/**
 * Task events that count as a person stepping in, an escalation to another provider, or a
 * re-run. Counts only; no content is read beyond these markers.
 */
export function interventionCountsSql(eventsAlias: string, tasksAlias: string): string {
  const type = (name: string) =>
    `(${eventsAlias}.type = '${name}' OR ${eventsAlias}.legacy_type = '${name}')`;
  return `
    SUM(CASE WHEN (${type("approval_granted")} OR ${type("approval_denied")})
      AND instr(${eventsAlias}.payload, '"autoApproved":true') = 0
      AND instr(${eventsAlias}.payload, '"autoResolved":true') = 0 THEN 1 ELSE 0 END) AS approval_decisions,
    SUM(CASE WHEN ${type("input_request_resolved")} THEN 1 ELSE 0 END) AS input_answers,
    SUM(CASE WHEN ${type("user_message")} AND ${eventsAlias}.timestamp > ${tasksAlias}.created_at + 5000
      THEN 1 ELSE 0 END) AS steering_messages,
    SUM(CASE WHEN ${type("llm_routing_changed")}
      AND instr(${eventsAlias}.payload, '"fallbackOccurred":true') > 0 THEN 1 ELSE 0 END) AS provider_escalations,
    SUM(CASE WHEN ${type("retry_started")} THEN 1 ELSE 0 END) AS rework_runs`;
}

export interface InterventionCounts {
  approvalDecisions: number;
  inputAnswers: number;
  steeringMessages: number;
  providerEscalations: number;
  reworkRuns: number;
}

export function emptyInterventionCounts(): InterventionCounts {
  return {
    approvalDecisions: 0,
    inputAnswers: 0,
    steeringMessages: 0,
    providerEscalations: 0,
    reworkRuns: 0,
  };
}

export function addInterventionRow(
  counts: InterventionCounts,
  row: Partial<Record<string, unknown>> | undefined,
): void {
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  counts.approvalDecisions += n(row?.approval_decisions);
  counts.inputAnswers += n(row?.input_answers);
  counts.steeringMessages += n(row?.steering_messages);
  counts.providerEscalations += n(row?.provider_escalations);
  counts.reworkRuns += n(row?.rework_runs);
}
